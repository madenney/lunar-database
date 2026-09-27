/**
 * Clear impossible replay dates: before Slippi existed (2018) or in the future,
 * which come from recording devices with wrong clocks. The recorded value moves to
 * startAtRaw; startAt becomes null (undated), in both replays and gameStats.
 * New crawls apply the same rule (services/slpParser.ts plausibleStartAt).
 *
 *   npm run fix-impossible-dates            dry run
 *   npm run fix-impossible-dates -- --apply
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay } from "../models/Replay";
import { GameStats } from "../models/GameStats";
import { EARLIEST_REPLAY_DATE } from "../services/slpParser";

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDb();
  const latest = new Date(Date.now() + 24 * 3600 * 1000);
  const impossible = { $or: [{ startAt: { $lt: EARLIEST_REPLAY_DATE } }, { startAt: { $gt: latest } }] };

  const rows = await Replay.find(impossible).select({ _id: 1, startAt: 1 }).lean();
  console.log(`${apply ? "APPLYING" : "DRY RUN"}: ${rows.length} replays with impossible dates`);
  if (apply && rows.length) {
    const r = await Replay.bulkWrite(
      rows.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { startAtRaw: d.startAt, startAt: null } } } }))
    );
    const g = await GameStats.collection.updateMany({ replayId: { $in: rows.map((d) => d._id) } }, { $set: { startAt: null } });
    console.log(`Updated ${r.modifiedCount} replays and ${g.modifiedCount} gameStats records.`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("fix-impossible-dates failed:", err);
  process.exit(1);
});
