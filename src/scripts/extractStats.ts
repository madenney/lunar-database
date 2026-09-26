/**
 * Extract per-game stats from every usable replay, as a stats run.
 *   - gameStats (MongoDB): one document per replay; each extractor $sets its own
 *     fields and records its version (services/gameStats.ts EXTRACTORS).
 *   - <detail-dir>/<extractor>/v<version>/<shard>.jsonl.gz: one line per replay,
 *     {r: replayId, ...that extractor's events} (rows as typed in gameStats.ts).
 *
 * A run names the extractors it computes and is fixed to their versions. The
 * first run computes everything; later runs add a new extractor or recompute one
 * whose version changed, without redoing the rest. Work is split into shards
 * (replay-ID ranges, services/statsShards.ts) that any number of machines claim
 * with expiring leases, against the same MongoDB and detail directory.
 *
 *   npm run extract-stats -- --run NAME --plan [--extractors a,b] [--shard-size N]
 *       create the run (default: all extractors) or extend it to new replays
 *   npm run extract-stats -- --run NAME --detail-dir DIR [--workers N] [--max-shards N] [--lease-minutes N]
 *   npm run extract-stats -- --run NAME --status
 *   npm run extract-stats -- --runs                 list runs
 *
 * STATS_NAMESPACE=pilot writes to gameStats_pilot / statsShards_pilot / statsRuns_pilot
 * instead of the published collections (use a separate --detail-dir too). Shards
 * are claimed in random order, so a partial run is spread across the archive.
 * A shard counts as done only when committed. SIGINT/SIGTERM hand the current shard
 * back; a runner that dies loses its lease and the shard is claimed again.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { Worker } from "worker_threads";
import mongoose from "mongoose";
import { connectDb } from "../db";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { GameStats } from "../models/GameStats";
import { EXTRACTOR_NAMES, type ExtractorName, type GameExtraction } from "../services/gameStats";
import { StatsRun } from "../models/StatsRun";
import type { ShardFile } from "../models/StatsShard";
import {
  assertRunMatchesCode,
  ensureRun,
  claimShard,
  commitShard,
  failShard,
  planShards,
  publishDetailFile,
  releaseShard,
  renewLease,
  shardStatusCounts,
} from "../services/statsShards";

const BATCH = 25; // replays per worker message
const WRITE_BATCH = 500; // gameStats upserts per bulkWrite
const DEFAULT_SHARD_SIZE = 5_000;

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Job = { id: string; filePath: string };
type Result = { id: string; extraction?: GameExtraction; error?: string };

function parserVersion(): string {
  try {
    const pkg = path.join(__dirname, "../../node_modules/@slippi/slippi-js/package.json");
    return `@slippi/slippi-js@${JSON.parse(fs.readFileSync(pkg, "utf8")).version}`;
  } catch {
    return "@slippi/slippi-js";
  }
}

/** A fixed pool of statsWorker threads; a thread that dies is replaced. */
class WorkerPool {
  private idle: Worker[] = [];
  private waiting: ((w: Worker) => void)[] = [];
  private all = new Set<Worker>();
  private readonly workerPath = path.join(__dirname, "../services/statsWorker.ts");

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.idle.push(this.spawn());
  }

  private spawn(): Worker {
    const w = new Worker(this.workerPath, { execArgv: ["--require", "ts-node/register/transpile-only"] });
    this.all.add(w);
    return w;
  }

  private release(w: Worker) {
    if (this.waiting.length) this.waiting.shift()!(w);
    else this.idle.push(w);
  }

  async run(jobs: Job[], extractors: ExtractorName[]): Promise<Result[]> {
    const w = await new Promise<Worker>((resolve) =>
      this.idle.length ? resolve(this.idle.pop()!) : this.waiting.push(resolve)
    );
    try {
      const results = await new Promise<Result[]>((resolve, reject) => {
        w.once("message", resolve);
        w.once("error", reject);
        w.once("exit", (code) => reject(new Error(`stats worker exited (${code})`)));
        w.postMessage({ jobs, extractors, slpRoot: config.slpRootDir, slpzRoot: config.slpzArchiveDir, slpzBinary: config.slpzBinary });
      });
      w.removeAllListeners("error");
      w.removeAllListeners("exit");
      this.release(w);
      return results;
    } catch (err) {
      w.removeAllListeners();
      this.all.delete(w);
      void w.terminate();
      this.release(this.spawn());
      throw err;
    }
  }

  async close() {
    await Promise.all([...this.all].map((w) => w.terminate()));
  }
}

async function main() {
  await connectDb();
  const owner = `${os.hostname()}-${process.pid}`;
  const parser = parserVersion();

  if (process.argv.includes("--runs")) {
    for (const r of await StatsRun.find().sort({ createdAt: 1 }).lean()) {
      console.log(r._id, r.extractors, await shardStatusCounts(r._id));
    }
    return mongoose.disconnect();
  }
  const runName = option("--run");
  if (!runName) throw new Error("Pass --run NAME (see --runs)");

  if (process.argv.includes("--status")) {
    console.log(`Run ${runName} shards:`, await shardStatusCounts(runName));
    return mongoose.disconnect();
  }
  if (process.argv.includes("--plan")) {
    const requested = option("--extractors")?.split(",").map((e) => e.trim()) ?? EXTRACTOR_NAMES;
    const unknown = requested.filter((e) => !(EXTRACTOR_NAMES as string[]).includes(e));
    if (unknown.length) throw new Error(`Unknown extractor(s): ${unknown.join(", ")} (have ${EXTRACTOR_NAMES.join(", ")})`);
    const run = await ensureRun(runName, requested as ExtractorName[], parser, owner);
    const size = Number(option("--shard-size")) || DEFAULT_SHARD_SIZE;
    const created = await planShards(run._id, size);
    console.log(`Run ${run._id} (${JSON.stringify(run.extractors)}): planned ${created} new shard(s) of up to ${size} replays`);
    console.log(await shardStatusCounts(run._id));
    return mongoose.disconnect();
  }

  const run = await StatsRun.findById(runName).lean();
  if (!run) throw new Error(`No run "${runName}"; create it with --plan`);
  assertRunMatchesCode(run);
  const extractors = Object.keys(run.extractors) as ExtractorName[];

  const detailDir = option("--detail-dir") ?? process.env.STATS_DETAIL_DIR;
  if (!detailDir) throw new Error("Pass --detail-dir DIR (or STATS_DETAIL_DIR)");
  const numWorkers = Number(option("--workers")) || Math.max(1, os.cpus().length - 4);
  const maxShards = Number(option("--max-shards")) || Infinity;
  const leaseMs = (Number(option("--lease-minutes")) || 10) * 60_000;
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (!stopping) console.log(`${sig}: handing back the current shard, then stopping (rerun to resume)`);
      stopping = true;
    });
  }

  const ns = process.env.STATS_NAMESPACE ? ` [namespace ${process.env.STATS_NAMESPACE}]` : "";
  console.log(`Run ${runName} ${JSON.stringify(run.extractors)} runner ${owner}${ns}: ${numWorkers} workers, detail in ${detailDir}`);
  console.log(await shardStatusCounts(runName));
  const pool = new WorkerPool(numWorkers);
  const started = Date.now();
  let shards = 0;
  let games = 0;
  let errors = 0;

  while (!stopping && shards < maxShards) {
    const shard = await claimShard(runName, owner, leaseMs);
    if (!shard) break;
    const id = shard._id;
    let lost = false;
    const heartbeat = setInterval(() => {
      renewLease(id, owner, leaseMs)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {});
    }, leaseMs / 4);

    try {
      const replays = await Replay.find({ usable: true, _id: { $gte: shard.fromId, $lte: shard.toId } })
        .select({ filePath: 1, source: 1, startAt: 1 })
        .lean();
      // Read in folder order: the archive is one spinning disk, and neighbouring
      // files need far fewer seeks (measured ~130 files/s vs ~80 in random order).
      replays.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));

      const results: Result[] = [];
      const inFlight = new Set<Promise<void>>();
      for (let i = 0; i < replays.length && !stopping && !lost; i += BATCH) {
        const jobs = replays.slice(i, i + BATCH).map((d) => ({ id: String(d._id), filePath: d.filePath }));
        const p = pool.run(jobs, extractors).then((r) => {
          results.push(...r);
        });
        inFlight.add(p);
        p.finally(() => inFlight.delete(p)).catch(() => {});
        if (inFlight.size >= numWorkers) await Promise.race(inFlight);
      }
      await Promise.all(inFlight);

      if (stopping) {
        await releaseShard(id, owner);
        break;
      }
      if (lost) throw new Error("lease lost");

      // 1. Detail files, durably in place (one per extractor with events).
      results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const files: Record<string, ShardFile> = {};
      for (const e of extractors) {
        const lines = results
          .filter((r) => r.extraction?.events[e])
          .map((r) => JSON.stringify({ r: r.id, ...r.extraction!.events[e] }) + "\n");
        if (!lines.length) continue;
        const rel = `${e}/v${run.extractors[e]}`;
        const published = publishDetailFile(path.join(detailDir, rel), `${id}.jsonl.gz`, lines, owner);
        files[e] = { file: `${rel}/${id}.jsonl.gz`, ...published };
      }

      // 2. Summaries: each extractor's fields and version, leaving other extractors' alone.
      const meta = new Map(replays.map((d) => [String(d._id), d]));
      const now = new Date();
      const ops = results.map((r) => {
        const m = meta.get(r.id)!;
        const replayId = new mongoose.Types.ObjectId(r.id);
        const set: Record<string, unknown> = { filePath: m.filePath, source: m.source ?? null, startAt: m.startAt ?? null, extractedAt: now };
        const unset: Record<string, ""> = {};
        if (r.error) {
          set.error = r.error;
        } else {
          const x = r.extraction!;
          Object.assign(set, x.fields);
          set.error = null;
          for (const e of extractors) {
            set[`extractors.${e}`] = x.versions[e];
            set[`shards.${e}`] = id;
            if (x.errors[e]?.length) set[`extractorErrors.${e}`] = x.errors[e];
            else unset[`extractorErrors.${e}`] = "";
          }
        }
        const update: Record<string, unknown> = { $set: set };
        if (Object.keys(unset).length) update.$unset = unset;
        return { updateOne: { filter: { replayId }, update, upsert: true } };
      });
      for (let i = 0; i < ops.length; i += WRITE_BATCH) {
        if (lost) throw new Error("lease lost");
        // Raw driver: Mongoose would silently drop fields the schema doesn't declare.
        await GameStats.collection.bulkWrite(ops.slice(i, i + WRITE_BATCH) as any, { ordered: false });
      }

      const shardErrors = results.filter((r) => r.error).length;
      const ok = await commitShard(id, owner, { games: results.length, failedGames: shardErrors, files, parser });
      if (!ok) throw new Error("lease lost before commit");

      shards++;
      games += results.length;
      errors += shardErrors;
      const rate = games / ((Date.now() - started) / 1000);
      console.log(`${id}: ${results.length} games, ${shardErrors} errors | total ${games.toLocaleString()} at ${rate.toFixed(1)}/s`);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      console.error(`${id} failed: ${message}`);
      await failShard(id, owner, message).catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  }

  await pool.close();
  const minutes = (Date.now() - started) / 60000;
  console.log(
    `Done${stopping ? " (stopped early)" : ""}. ${shards} shard(s), ${games.toLocaleString()} games ` +
      `(${errors} errors) in ${minutes.toFixed(1)} min.`
  );
  console.log(await shardStatusCounts(runName));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Stats extraction failed:", err);
  process.exit(1);
});
