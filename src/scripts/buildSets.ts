/**
 * Build tournament sets from the metadata beside tournament replays:
 * context.json (start.gg set exports) and set.json (Jungle). Links each game's
 * Replay to its set (setId, setGame). Re-runnable: sets are replaced, and sets
 * no longer found are removed along with their replay links. Online sets matched
 * by startgg-sync (source "startgg-match") are left alone.
 *
 *   npm run build-sets
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { connectDb } from "../db";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { TournamentSet } from "../models/TournamentSet";
import { parseContextSet, parseJungleSet, type ParsedSet } from "../services/sets";

/** Folders under root/tournament holding a context.json or set.json (real files only). */
function* metadataDirs(root: string, rel = "tournament"): Generator<{ dir: string; file: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  const meta = entries.find((e) => e.isFile() && (e.name === "context.json" || e.name === "set.json"));
  if (meta) yield { dir: rel, file: meta.name };
  for (const e of entries) if (e.isDirectory()) yield* metadataDirs(root, `${rel}/${e.name}`);
}

async function main() {
  await connectDb();
  const root = config.slpRootDir;
  const builtAt = new Date();
  const started = Date.now();
  let sets = 0;
  let linked = 0;
  let unreadable = 0;
  const ids: string[] = [];
  let setOps: any[] = [];
  let replayOps: any[] = [];
  const flush = async () => {
    if (setOps.length) await TournamentSet.collection.bulkWrite(setOps, { ordered: false });
    if (replayOps.length) await Replay.collection.bulkWrite(replayOps, { ordered: false });
    setOps = [];
    replayOps = [];
  };

  for (const { dir, file } of metadataDirs(root)) {
    let parsed: ParsedSet;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(root, dir, file), "utf8"));
      const files = fs.readdirSync(path.join(root, dir)).filter((f) => f.toLowerCase().endsWith(".slp"));
      parsed = file === "set.json" ? parseJungleSet(json, dir) : parseContextSet(json, dir, files);
    } catch {
      unreadable++;
      continue;
    }
    const docs = await Replay.find({ filePath: { $in: parsed.games.map((g) => `${dir}/${g.file}`) } })
      .select({ filePath: 1 })
      .lean();
    const byFile = new Map(docs.map((d) => [path.basename(d.filePath), d._id]));
    const games = parsed.games.map((g) => ({ replayId: byFile.get(g.file) ?? null, n: g.n, winner: g.winner }));
    if (!games.some((g) => g.replayId)) continue; // none of its games are indexed
    const { _id, ...rest } = parsed;
    setOps.push({
      replaceOne: {
        filter: { _id },
        replacement: { ...rest, tournamentKey: parsed.tournament.key, dir, games, builtAt },
        upsert: true,
      },
    });
    for (const g of games) {
      if (!g.replayId) continue;
      replayOps.push({ updateOne: { filter: { _id: g.replayId }, update: { $set: { setId: _id, setGame: g.n } } } });
      linked++;
    }
    ids.push(_id);
    sets++;
    if (setOps.length >= 500) await flush();
    if (sets % 5000 === 0) console.log(`${sets.toLocaleString()} sets, ${linked.toLocaleString()} games linked`);
  }
  await flush();

  const stale = await TournamentSet.deleteMany({ builtAt: { $lt: builtAt }, source: { $ne: "startgg-match" } });
  const matchedIds = (await TournamentSet.find({ source: "startgg-match" }).select({ _id: 1 }).lean()).map((s) => String(s._id));
  const unlinked = await Replay.updateMany(
    { setId: { $type: "string", $nin: [...ids, ...matchedIds] } },
    { $set: { setId: null, setGame: null } }
  );
  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(0)}s: ${sets.toLocaleString()} sets, ${linked.toLocaleString()} games linked, ` +
      `${unreadable} unreadable metadata files, ${stale.deletedCount} stale sets removed, ${unlinked.modifiedCount} replays unlinked.`
  );
  await TournamentSet.syncIndexes();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("build-sets failed:", err);
  process.exit(1);
});
