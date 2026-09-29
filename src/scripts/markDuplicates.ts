/**
 * Hide extra recordings of the same game. The archive often holds one game
 * twice (the console's recording and a stream PC's, or two donors' copies);
 * their bytes differ, so the import's hash check can't catch them, but their
 * stats fingerprint (stage, random seed, match ID/game number, each player's
 * port/character/colour/code/stocks) is the same.
 *
 * For each fingerprint group whose recordings also agree on length (within
 * MAX_SPREAD_FRAMES; groups with unknown or differing lengths, e.g. partial
 * spectator captures, are left alone), one recording stays visible and the
 * others get duplicateOf = that one and usable = false. Nothing is deleted:
 * hidden copies keep their files, stats and pages, and --undo restores them.
 *
 * Which copy stays: see services/duplicates.ts (set-linked, else largest, else first).
 *
 *   npm run mark-duplicates              dry run: what would change
 *   npm run mark-duplicates -- --apply
 *   npm run mark-duplicates -- --undo    un-hide everything
 *
 * Re-runnable after imports. Then rebuild what counts games:
 * build-tournaments, build-player-stats, build-players.
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay, isUsableReplay } from "../models/Replay";
import { GameStats } from "../models/GameStats";
import { sameGame, pickCanonical, type Recording } from "../services/duplicates";

async function undo(apply: boolean) {
  const hidden = await Replay.countDocuments({ duplicateOf: { $type: "objectId" } });
  console.log(`${hidden.toLocaleString()} replays marked as duplicates.`);
  if (!apply) return console.log("Dry run: add --apply to restore them.");
  let restored = 0;
  const cursor = Replay.find({ duplicateOf: { $type: "objectId" } }).select({ stageId: 1, duration: 1, "players.characterId": 1 }).lean().cursor();
  let ops: any[] = [];
  for await (const r of cursor) {
    ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { duplicateOf: null, usable: isUsableReplay({ ...r, duplicateOf: null } as any) } } } });
    if (ops.length >= 2000) (restored += (await Replay.collection.bulkWrite(ops, { ordered: false })).modifiedCount), (ops = []);
  }
  if (ops.length) restored += (await Replay.collection.bulkWrite(ops, { ordered: false })).modifiedCount;
  console.log(`Restored ${restored.toLocaleString()}.`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDb();
  if (process.argv.includes("--undo")) return undo(apply).then(() => mongoose.disconnect());

  const started = Date.now();
  const groups = GameStats.collection.aggregate<{ _id: string; ids: mongoose.Types.ObjectId[] }>(
    [
      { $match: { fingerprint: { $type: "string" } } },
      { $group: { _id: "$fingerprint", ids: { $push: "$replayId" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ],
    { allowDiskUse: true }
  );

  const hide = new Map<string, mongoose.Types.ObjectId>(); // replay -> canonical
  let checked = 0;
  let skipped = 0;
  for await (const g of groups) {
    const recs = (await Replay.find({ _id: { $in: g.ids } }).select({ duration: 1, fileSize: 1, setId: 1 }).lean()) as unknown as Recording[];
    if (!sameGame(recs)) {
      skipped++;
      continue;
    }
    const canonical = pickCanonical(recs);
    for (const r of recs) if (String(r._id) !== String(canonical._id)) hide.set(String(r._id), new mongoose.Types.ObjectId(String(canonical._id)));
    if (++checked % 10_000 === 0) console.log(`  ${checked.toLocaleString()} groups…`);
  }

  // Replays marked before that are no longer duplicates (their group changed) come back.
  const previously = await Replay.find({ duplicateOf: { $type: "objectId" } }).select({ _id: 1, duplicateOf: 1 }).lean();
  const before = new Map(previously.map((r) => [String(r._id), String(r.duplicateOf)]));
  const unhide = previously.filter((r) => !hide.has(String(r._id)));
  const changed = [...hide].filter(([id, c]) => before.get(id) !== String(c));

  console.log(
    `${checked.toLocaleString()} duplicate groups (${skipped.toLocaleString()} skipped: unknown or differing lengths). ` +
      `${hide.size.toLocaleString()} extra copies to hide (${changed.length.toLocaleString()} new or changed), ${unhide.length.toLocaleString()} to un-hide. ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s`
  );
  if (!apply) {
    console.log("Dry run: add --apply to write.");
    return mongoose.disconnect();
  }

  let ops: any[] = [];
  const flush = async () => {
    if (ops.length) await Replay.collection.bulkWrite(ops, { ordered: false });
    ops = [];
  };
  for (const [id, canonical] of changed) {
    ops.push({ updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: { duplicateOf: canonical, usable: false } } } });
    if (ops.length >= 2000) await flush();
  }
  for (const r of unhide) {
    const doc = await Replay.findById(r._id).select({ stageId: 1, duration: 1, "players.characterId": 1 }).lean();
    ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { duplicateOf: null, usable: isUsableReplay({ ...(doc as any), duplicateOf: null }) } } } });
    if (ops.length >= 2000) await flush();
  }
  await flush();
  await Replay.syncIndexes();
  console.log("Applied. Now rebuild: build-tournaments, build-player-stats, build-players.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("mark-duplicates failed:", err);
  process.exit(1);
});
