/**
 * Rebuild player profiles (playerStats) from gameStats. Run after a stats run or
 * a crawl + stats extension: npm run build-player-stats
 *
 * Streams every extracted game once and aggregates in memory (one small record per
 * connect code), then replaces the collection's contents: profiles are upserted
 * with this build's timestamp and profiles not seen in this build are removed.
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { GameStats } from "../models/GameStats";
import { Replay } from "../models/Replay";
import { PlayerStats } from "../models/PlayerStats";
import { PlayerStatsBuilder } from "../services/playerStats";

const WRITE_BATCH = 1000;

async function main() {
  await connectDb();
  const builtAt = new Date();
  const builder = new PlayerStatsBuilder();
  const started = Date.now();

  const cursor = GameStats.collection.find(
    { error: null, numPlayers: 2, hasCpu: false, "extractors.core": { $exists: true } },
    {
      projection: {
        replayId: 1, source: 1, startAt: 1, stageId: 1, winner: 1, numPlayers: 1, hasCpu: 1,
        "players.playerIndex": 1, "players.connectCode": 1, "players.displayName": 1, "players.userId": 1,
        "players.characterId": 1, "players.stocksLost": 1, "players.kills": 1, "players.openings": 1,
        "players.damageDealt": 1, "players.neutralWins": 1, "players.counterHits": 1, "players.inputsPerMinute": 1,
        "players.actions.lCancelCount": 1, "players.actions.wavedashCount": 1, "players.actions.dashDanceCount": 1,
        "players.actions.ledgegrabCount": 1, "position.players": 1, techLedge: 1,
      },
      batchSize: 5000,
    }
  );
  // Extra recordings of a game we already count (scripts/markDuplicates.ts).
  const duplicates = new Set(
    (await Replay.find({ duplicateOf: { $type: "objectId" } }).select({ _id: 1 }).lean()).map((r) => String(r._id))
  );
  let games = 0;
  for await (const g of cursor) {
    if (duplicates.has(String((g as any).replayId))) continue;
    builder.add(g as any);
    if (++games % 200_000 === 0) console.log(`${games.toLocaleString()} games, ${builder.size.toLocaleString()} players`);
  }
  console.log(`Aggregated ${games.toLocaleString()} games into ${builder.size.toLocaleString()} players in ${((Date.now() - started) / 1000).toFixed(0)}s`);

  let ops: any[] = [];
  let written = 0;
  for (const p of builder.profiles()) {
    ops.push({ replaceOne: { filter: { connectCode: p.connectCode }, replacement: { ...p, builtAt }, upsert: true } });
    if (ops.length >= WRITE_BATCH) {
      await PlayerStats.collection.bulkWrite(ops, { ordered: false });
      written += ops.length;
      ops = [];
    }
  }
  if (ops.length) {
    await PlayerStats.collection.bulkWrite(ops, { ordered: false });
    written += ops.length;
  }
  // Only prune when this build wrote every profile it made.
  if (written === builder.size) {
    const { deletedCount } = await PlayerStats.deleteMany({ builtAt: { $lt: builtAt } });
    console.log(`Wrote ${written.toLocaleString()} profiles; removed ${deletedCount} stale.`);
  } else {
    console.log(`Wrote ${written} of ${builder.size} profiles; not pruning.`);
  }
  await PlayerStats.syncIndexes();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("build-player-stats failed:", err);
  process.exit(1);
});
