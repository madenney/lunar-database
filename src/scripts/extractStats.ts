/**
 * Extract full per-game stats from every usable replay.
 *   - gameStats (MongoDB): one summary per replay, for the site and rating fits.
 *   - <detail-dir>/conversions-*.jsonl.gz: one line per replay, {r: replayId, c: rows},
 *     rows as in gameStats.ts ConversionRow. Kept off MongoDB (~40 GB for the archive).
 *
 *   npm run extract-stats -- --detail-dir DIR [--limit N | --sample N] [--workers N]
 *   npm run extract-stats -- --no-detail ...
 *
 * Resumable: replays already extracted at the current STATS_VERSION are skipped, so a
 * stopped run picks up where it left off. SIGINT/SIGTERM drain in-flight work first.
 */
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { Worker } from "worker_threads";
import mongoose from "mongoose";
import { connectDb } from "../db";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { GameStats } from "../models/GameStats";
import { STATS_VERSION } from "../services/gameStats";

const BATCH = 25; // replays per worker message
const WRITE_BATCH = 500; // gameStats upserts per bulkWrite
const SHARD_GAMES = 100_000; // replays per detail file

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Result = { id: string; summary?: any; conversions?: unknown[]; error?: string };

async function main() {
  const limit = Number(option("--limit")) || undefined;
  const sample = Number(option("--sample")) || undefined;
  const numWorkers = Number(option("--workers")) || Math.max(1, os.cpus().length - 4);
  const noDetail = process.argv.includes("--no-detail");
  const detailDir = option("--detail-dir") ?? process.env.STATS_DETAIL_DIR;
  if (!noDetail && !detailDir) throw new Error("Pass --detail-dir DIR (or STATS_DETAIL_DIR), or --no-detail");
  if (detailDir) fs.mkdirSync(detailDir, { recursive: true });

  await connectDb();
  const match = { usable: true };
  const total = sample ?? limit ?? (await Replay.countDocuments(match));
  console.log(`Extracting stats v${STATS_VERSION} from ${total.toLocaleString()} replays with ${numWorkers} workers`);

  // --- detail output -------------------------------------------------------
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  let shard: zlib.Gzip | null = null;
  const shardFiles: fs.WriteStream[] = [];
  let shardGames = 0;
  let shardSeq = 0;
  function writeDetail(id: string, conversions: unknown[]) {
    if (noDetail) return;
    if (!shard || shardGames >= SHARD_GAMES) {
      shard?.end();
      const file = path.join(detailDir!, `conversions-${runStamp}-${String(shardSeq++).padStart(4, "0")}.jsonl.gz`);
      shard = zlib.createGzip();
      const out = fs.createWriteStream(file);
      shardFiles.push(out);
      shard.pipe(out);
      shardGames = 0;
    }
    shard.write(JSON.stringify({ r: id, c: conversions }) + "\n");
    shardGames++;
  }

  // --- MongoDB output ------------------------------------------------------
  const meta = new Map<string, { filePath: string; source: string | null; startAt: Date | null }>();
  let ops: any[] = [];
  let done = 0;
  let errors = 0;
  let skipped = 0;
  const started = Date.now();
  async function flush() {
    if (ops.length === 0) return;
    const batch = ops;
    ops = [];
    await GameStats.bulkWrite(batch, { ordered: false });
  }
  async function handle(results: Result[]) {
    for (const r of results) {
      const m = meta.get(r.id)!;
      meta.delete(r.id);
      const base = { replayId: new mongoose.Types.ObjectId(r.id), ...m, extractedAt: new Date() };
      const doc = r.error ? { ...base, version: STATS_VERSION, error: r.error } : { ...base, ...r.summary, error: null };
      if (r.error) errors++;
      else writeDetail(r.id, r.conversions ?? []);
      ops.push({ replaceOne: { filter: { replayId: base.replayId }, replacement: doc, upsert: true } });
      done++;
      if (done % 2000 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        const left = Math.max(0, total - done - skipped);
        console.log(
          `${done.toLocaleString()} extracted, ${errors} errors, ${skipped.toLocaleString()} already done | ` +
            `${rate.toFixed(1)}/s | ETA ${(left / rate / 3600).toFixed(1)} h`
        );
      }
    }
    if (ops.length >= WRITE_BATCH) await flush();
  }

  // --- workers -------------------------------------------------------------
  const workerPath = path.join(__dirname, "../services/statsWorker.ts");
  const workers = Array.from(
    { length: numWorkers },
    () => new Worker(workerPath, { execArgv: ["--require", "ts-node/register/transpile-only"] })
  );
  const idle = [...workers];
  const waiting: ((w: Worker) => void)[] = [];
  const inFlight = new Set<Promise<void>>();
  const takeWorker = () =>
    new Promise<Worker>((resolve) => (idle.length ? resolve(idle.pop()!) : waiting.push(resolve)));
  const releaseWorker = (w: Worker) => (waiting.length ? waiting.shift()!(w) : idle.push(w));
  async function dispatch(jobs: { id: string; filePath: string }[]) {
    const w = await takeWorker();
    const p = new Promise<Result[]>((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
      w.postMessage({ jobs, slpRoot: config.slpRootDir, slpzRoot: config.slpzArchiveDir, slpzBinary: config.slpzBinary });
    })
      .then(handle)
      .finally(() => {
        w.removeAllListeners("error");
        releaseWorker(w);
        inFlight.delete(p);
      });
    inFlight.add(p);
  }

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (!stopping) console.log(`${sig}: finishing in-flight replays, then stopping (rerun to resume)`);
      stopping = true;
    });
  }

  // --- replay source -------------------------------------------------------
  const project = { filePath: 1, source: 1, startAt: 1 };
  const source: AsyncIterable<any> = sample
    ? Replay.aggregate([{ $match: match }, { $sample: { size: sample } }, { $project: project }]).cursor({ batchSize: 1000 })
    : Replay.find(match).sort({ _id: 1 }).select(project).limit(limit ?? 0).lean().cursor({ batchSize: 1000 });

  let pending: any[] = [];
  async function queue(batch: any[]) {
    const ids = batch.map((d) => d._id);
    const have = new Set(
      (await GameStats.find({ replayId: { $in: ids }, version: STATS_VERSION }).select("replayId").lean()).map((d) =>
        String(d.replayId)
      )
    );
    skipped += have.size;
    const jobs = batch
      .filter((d) => !have.has(String(d._id)))
      .map((d) => {
        meta.set(String(d._id), { filePath: d.filePath, source: d.source ?? null, startAt: d.startAt ?? null });
        return { id: String(d._id), filePath: d.filePath };
      });
    if (jobs.length) await dispatch(jobs);
  }
  for await (const doc of source) {
    if (stopping) break;
    pending.push(doc);
    if (pending.length >= BATCH) {
      await queue(pending);
      pending = [];
    }
  }
  if (!stopping && pending.length) await queue(pending);

  await Promise.all(inFlight);
  await flush();
  // Close the last shard and wait until every detail file is fully on disk.
  (shard as zlib.Gzip | null)?.end();
  await Promise.all(shardFiles.map((f) => (f.writableFinished ? null : new Promise((r) => f.on("finish", r)))));
  await Promise.all(workers.map((w) => w.terminate()));
  const minutes = (Date.now() - started) / 60000;
  console.log(
    `Done${stopping ? " (stopped early)" : ""}. Extracted ${done.toLocaleString()} (${errors} errors), ` +
      `skipped ${skipped.toLocaleString()} already done, in ${minutes.toFixed(1)} min.`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Stats extraction failed:", err);
  process.exit(1);
});
