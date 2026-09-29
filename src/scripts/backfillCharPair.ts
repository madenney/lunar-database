/**
 * Fill Replay.charPair (models/Replay.ts charPairOf) on replays indexed before it
 * existed, so matchup searches find them. Idempotent; only writes docs that differ.
 *
 *   npm run backfill-charpair            dry run: how many would change
 *   npm run backfill-charpair -- --apply
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay, charPairOf } from "../models/Replay";

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDb();
  const started = Date.now();
  let seen = 0;
  let changes = 0;
  let ops: any[] = [];
  const cursor = Replay.collection.find({}, { projection: { charPair: 1, "players.characterId": 1 }, batchSize: 10_000 });
  for await (const r of cursor) {
    seen++;
    const pair = charPairOf(r.players);
    if ((r.charPair ?? null) !== pair) {
      changes++;
      if (apply) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { charPair: pair } } } });
    }
    if (ops.length >= 5000) {
      await Replay.collection.bulkWrite(ops, { ordered: false });
      ops = [];
    }
    if (seen % 500_000 === 0) console.log(`  ${seen.toLocaleString()} replays, ${changes.toLocaleString()} to update`);
  }
  if (ops.length) await Replay.collection.bulkWrite(ops, { ordered: false });
  console.log(`${seen.toLocaleString()} replays, ${changes.toLocaleString()} ${apply ? "updated" : "would change (dry run: add --apply)"} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (apply) {
    await Replay.syncIndexes();
    console.log("Indexes synced.");
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("backfill-charpair failed:", err);
  process.exit(1);
});
