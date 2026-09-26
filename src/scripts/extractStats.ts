/**
 * Extract full per-game stats from every usable replay.
 *   - gameStats (MongoDB): one summary per replay, for the site and rating fits.
 *   - <detail-dir>/v<version>/<shard>.jsonl.gz: one line per replay, {r: replayId, c: rows},
 *     rows as in gameStats.ts ConversionRow. Kept off MongoDB (~40 GB for the archive).
 *
 * Work is split into shards (fixed replay-ID ranges in the statsShards collection,
 * see services/statsShards.ts). Several machines can run this at once against the
 * same MongoDB and detail directory; each claims shards with an expiring lease.
 *
 *   npm run extract-stats -- --plan [--shard-size N]    plan shards for new usable replays
 *   npm run extract-stats -- --detail-dir DIR [--workers N] [--max-shards N] [--lease-minutes N]
 *   npm run extract-stats -- --status
 *
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
import { STATS_VERSION } from "../services/gameStats";
import {
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
type Result = { id: string; summary?: any; conversions?: unknown[]; error?: string };

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

  async run(jobs: Job[]): Promise<Result[]> {
    const w = await new Promise<Worker>((resolve) =>
      this.idle.length ? resolve(this.idle.pop()!) : this.waiting.push(resolve)
    );
    try {
      const results = await new Promise<Result[]>((resolve, reject) => {
        w.once("message", resolve);
        w.once("error", reject);
        w.once("exit", (code) => reject(new Error(`stats worker exited (${code})`)));
        w.postMessage({ jobs, slpRoot: config.slpRootDir, slpzRoot: config.slpzArchiveDir, slpzBinary: config.slpzBinary });
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

  if (process.argv.includes("--status")) {
    console.log(`Stats v${STATS_VERSION} shards:`, await shardStatusCounts(STATS_VERSION));
    return mongoose.disconnect();
  }
  if (process.argv.includes("--plan")) {
    const size = Number(option("--shard-size")) || DEFAULT_SHARD_SIZE;
    const created = await planShards(STATS_VERSION, size);
    console.log(`Planned ${created} new shard(s) of up to ${size} replays for stats v${STATS_VERSION}`);
    console.log(await shardStatusCounts(STATS_VERSION));
    return mongoose.disconnect();
  }

  const detailDir = option("--detail-dir") ?? process.env.STATS_DETAIL_DIR;
  if (!detailDir) throw new Error("Pass --detail-dir DIR (or STATS_DETAIL_DIR)");
  const numWorkers = Number(option("--workers")) || Math.max(1, os.cpus().length - 4);
  const maxShards = Number(option("--max-shards")) || Infinity;
  const leaseMs = (Number(option("--lease-minutes")) || 10) * 60_000;
  const owner = `${os.hostname()}-${process.pid}`;
  const parser = parserVersion();

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (!stopping) console.log(`${sig}: handing back the current shard, then stopping (rerun to resume)`);
      stopping = true;
    });
  }

  console.log(`Stats v${STATS_VERSION} runner ${owner}: ${numWorkers} workers, detail in ${detailDir}`);
  console.log(await shardStatusCounts(STATS_VERSION));
  const pool = new WorkerPool(numWorkers);
  const started = Date.now();
  let shards = 0;
  let games = 0;
  let errors = 0;

  while (!stopping && shards < maxShards) {
    const shard = await claimShard(STATS_VERSION, owner, leaseMs);
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

      const results: Result[] = [];
      const inFlight = new Set<Promise<void>>();
      for (let i = 0; i < replays.length && !stopping && !lost; i += BATCH) {
        const jobs = replays.slice(i, i + BATCH).map((d) => ({ id: String(d._id), filePath: d.filePath }));
        const p = pool.run(jobs).then((r) => {
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

      // 1. Detail file, durably in place. 2. Summaries tagged with this shard. 3. Commit.
      results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const lines = results.filter((r) => !r.error).map((r) => JSON.stringify({ r: r.id, c: r.conversions ?? [] }) + "\n");
      const file = `v${STATS_VERSION}/${id}.jsonl.gz`;
      const { bytes, sha256 } = publishDetailFile(path.join(detailDir, `v${STATS_VERSION}`), `${id}.jsonl.gz`, lines, owner);

      const meta = new Map(replays.map((d) => [String(d._id), d]));
      const now = new Date();
      const ops = results.map((r) => {
        const m = meta.get(r.id)!;
        const base = {
          replayId: new mongoose.Types.ObjectId(r.id),
          filePath: m.filePath,
          source: m.source ?? null,
          startAt: m.startAt ?? null,
          shard: id,
          extractedAt: now,
        };
        const doc = r.error ? { ...base, version: STATS_VERSION, error: r.error } : { ...base, ...r.summary, error: null };
        return { replaceOne: { filter: { replayId: base.replayId }, replacement: doc, upsert: true } };
      });
      for (let i = 0; i < ops.length; i += WRITE_BATCH) {
        if (lost) throw new Error("lease lost");
        await GameStats.bulkWrite(ops.slice(i, i + WRITE_BATCH), { ordered: false });
      }

      const shardErrors = results.filter((r) => r.error).length;
      const ok = await commitShard(id, owner, { games: results.length, failedGames: shardErrors, file, bytes, sha256, parser });
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
  console.log(await shardStatusCounts(STATS_VERSION));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Stats extraction failed:", err);
  process.exit(1);
});
