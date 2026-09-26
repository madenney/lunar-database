/**
 * Backfill Replay.matchId / gameNumber / tiebreaker / mode from gameStats.
 *
 * New crawls write match info at insert (services/slpParser.ts). Replays indexed
 * earlier get it from the stats extraction instead, which already parsed every
 * file: this copies gameStats.match onto the Replay without reading any replay.
 * Run it after an extraction run (v2 or later).
 *
 * Dry run (default) — reports what WOULD change, touches nothing:
 *   npm run backfill-match-info
 * Apply:
 *   npm run backfill-match-info -- --apply
 *
 * Idempotent: only replays whose matchId is still unset are considered.
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Replay } from "../models/Replay";
import { GameStats } from "../models/GameStats";

const BATCH = 2000;

async function main() {
  const apply = process.argv.includes("--apply");
  await connectDb();
  console.log(apply ? "APPLYING" : "DRY RUN (pass --apply to write)");

  const cursor = GameStats.find({ "match.id": { $type: "string" } })
    .select({ replayId: 1, match: 1 })
    .lean()
    .cursor({ batchSize: BATCH });

  let seen = 0;
  let changed = 0;
  let ops: any[] = [];
  const flush = async () => {
    if (!ops.length) return;
    if (apply) {
      const r = await Replay.bulkWrite(ops, { ordered: false });
      changed += r.modifiedCount;
    } else {
      changed += await Replay.countDocuments({ _id: { $in: ops.map((o) => o.updateOne.filter._id) }, matchId: null });
    }
    ops = [];
  };

  for await (const g of cursor) {
    const m = g.match!;
    ops.push({
      updateOne: {
        filter: { _id: g.replayId, matchId: null },
        update: { $set: { matchId: m.id, gameNumber: m.gameNumber, tiebreaker: m.tiebreaker, mode: m.mode } },
      },
    });
    seen++;
    if (ops.length >= BATCH) await flush();
    if (seen % 100_000 === 0) console.log(`${seen.toLocaleString()} scanned, ${changed.toLocaleString()} ${apply ? "updated" : "to update"}`);
  }
  await flush();
  console.log(`Done. ${seen.toLocaleString()} games with match info, ${changed.toLocaleString()} replays ${apply ? "updated" : "would be updated"}.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
