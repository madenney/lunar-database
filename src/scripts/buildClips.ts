/**
 * Build the clip search index (docs/clip-search.md, Phase 1a) from the stats
 * run's `clipper` detail files.
 *
 *   npm run build-clips                         dry run: counts per type, writes nothing
 *   npm run build-clips -- --shards 1           dry run on the first shard only
 *   npm run build-clips -- --apply              build `clips_build`, then swap it in as `clips`
 *   npm run build-clips -- --detail-dir DIR     default STATS_DETAIL_DIR
 *
 * Reads only files a committed shard of the run names, and checks each file's
 * SHA-256 first. Never modifies replays, gameStats or statsShards: it writes
 * only `clips_build`, `clips` (by rename) and a record in `clipBuilds`, so a
 * failed or interrupted run leaves the live index untouched. Re-run it after a
 * new stats run or mark-duplicates.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import readline from "readline";
import mongoose from "mongoose";
import { connectDb } from "../db";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { StatsShard } from "../models/StatsShard";
import { clipsFromLine, CLIP_INDEXES, type ClipperLine, type ClipDoc } from "../services/clips";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = args.includes("--apply");
const RUN = opt("--run") ?? "main";
const DETAIL_DIR = opt("--detail-dir") ?? config.statsDetailDir;
const MAX_SHARDS = Number(opt("--shards") ?? Infinity);
const BUILD = "clips_build";
const LIVE = "clips";

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function* lines(file: string): AsyncGenerator<ClipperLine> {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) yield JSON.parse(l);
}

async function main() {
  if (!DETAIL_DIR) throw new Error("No detail dir: pass --detail-dir or set STATS_DETAIL_DIR");
  await connectDb();
  const db = mongoose.connection.db!;
  const started = Date.now();
  const shards = await StatsShard.find({ run: RUN, status: "committed", "files.clipper.file": { $exists: true } })
    .select({ files: 1 })
    .sort({ _id: 1 })
    .lean();
  const todo = shards.slice(0, MAX_SHARDS);
  console.log(`${APPLY ? "BUILD" : "DRY RUN"}: ${todo.length} of ${shards.length} committed shards of run "${RUN}" from ${DETAIL_DIR}`);

  const build = db.collection<ClipDoc>(BUILD);
  if (APPLY) await build.drop().catch(() => {});

  const counts: Record<string, number> = { combo: 0, edgeguard: 0, quitout: 0 };
  let games = 0;
  let skippedGames = 0;
  let bytes = 0;
  for (const [i, shard] of todo.entries()) {
    const f = (shard.files as any).clipper as { file: string; sha256: string; lines: number };
    const file = path.join(DETAIL_DIR, f.file);
    if ((await sha256(file)) !== f.sha256) throw new Error(`Checksum mismatch: ${file} (not the file shard ${shard._id} committed)`);
    const version = Number(/\/v(\d+)\//.exec(f.file)?.[1] ?? 0);
    const detail = { run: RUN, extractor: "clipper" as const, version, shard: String(shard._id) };

    // One shard (~5,000 games) at a time: look its replays up in one query.
    const batch: ClipperLine[] = [];
    for await (const line of lines(file)) batch.push(line);
    const ids = batch.map((l) => new mongoose.Types.ObjectId(l.r));
    const replays = new Map(
      (
        await Replay.collection
          .find(
            { _id: { $in: ids } },
            { projection: { usable: 1, duration: 1, stageId: 1, source: 1, startAt: 1, "players.playerIndex": 1, "players.characterId": 1, "players.connectCode": 1, "players.displayName": 1 } }
          )
          .toArray()
      ).map((r) => [String(r._id), r])
    );
    const docs: ClipDoc[] = [];
    for (const line of batch) {
      games++;
      const replay = replays.get(line.r);
      if (!replay) {
        skippedGames++;
        continue;
      }
      const clips = clipsFromLine(line, replay as any, detail);
      for (const c of clips) counts[c.type]++;
      docs.push(...clips);
    }
    if (APPLY) for (let j = 0; j < docs.length; j += 5000) await build.insertMany(docs.slice(j, j + 5000), { ordered: false });
    bytes += docs.reduce((n, d) => n + JSON.stringify(d).length, 0);
    if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
      const total = counts.combo + counts.edgeguard + counts.quitout;
      console.log(
        `  ${i + 1}/${todo.length} shards, ${games.toLocaleString()} games: ${total.toLocaleString()} clips ` +
          `(${counts.combo.toLocaleString()} combos, ${counts.edgeguard.toLocaleString()} edgeguards, ${counts.quitout.toLocaleString()} quit-outs), ` +
          `~${(bytes / 1e9).toFixed(2)} GB as JSON, ${((Date.now() - started) / 60000).toFixed(1)} min`
      );
    }
  }
  const total = counts.combo + counts.edgeguard + counts.quitout;
  console.log(`${games.toLocaleString()} games read (${skippedGames} without a replay), ${total.toLocaleString()} clips.`);
  if (todo.length < shards.length) {
    const scale = shards.length / todo.length;
    console.log(`Projected for all ${shards.length} shards: ~${Math.round((total * scale) / 1e6)}M clips, ~${((bytes * scale) / 1e9).toFixed(0)} GB as JSON.`);
  }

  if (APPLY) {
    console.log("Creating indexes…");
    // Every search the API allows starts with `type` and an equality on one of
    // these, then sorts by rank ("best") or startAt; see routes/clips.ts.
    await build.createIndexes(CLIP_INDEXES);
    if (todo.length < shards.length) {
      console.log(`Partial build (${todo.length} shards) left in "${BUILD}"; live "${LIVE}" not replaced.`);
    } else {
      await build.rename(LIVE, { dropTarget: true });
      console.log(`Swapped "${BUILD}" in as "${LIVE}".`);
    }
    const stats = await db.command({ collStats: todo.length < shards.length ? BUILD : LIVE });
    await db.collection("clipBuilds").insertOne({
      builtAt: new Date(),
      run: RUN,
      shards: todo.length,
      partial: todo.length < shards.length,
      games,
      counts,
      storageBytes: stats.storageSize,
      indexBytes: stats.totalIndexSize,
      minutes: (Date.now() - started) / 60000,
    } as any);
    console.log(`On disk: ${(stats.storageSize / 1e9).toFixed(2)} GB data + ${(stats.totalIndexSize / 1e9).toFixed(2)} GB indexes.`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("build-clips failed:", err);
  process.exit(1);
});
