import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { Player } from "../models/Player";
import { connectDb } from "../db";

async function buildPlayers() {
  await connectDb();

  // Rebuild the autocomplete summary. Run after every crawl (npm run build-players):
  // the crawler doesn't maintain it. Counts only usable replays, so a player's
  // gameCount matches what a search for their code returns.
  console.log("Aggregating players from replays...");
  const builtAt = new Date();
  const pipeline = [
    { $match: { usable: true } },
    { $unwind: "$players" },
    { $match: { "players.connectCode": { $ne: null } } },
    {
      $group: {
        _id: "$players.connectCode",
        displayName: { $last: "$players.displayName" },
        tag: { $last: "$players.tag" },
        gameCount: { $sum: 1 },
      },
    },
  ];

  const cursor = Replay.aggregate(pipeline).cursor({ batchSize: 5000 });

  let upserted = 0;
  let batch: any[] = [];
  const BATCH_SIZE = 1000;

  for await (const doc of cursor) {
    batch.push({
      updateOne: {
        filter: { connectCode: doc._id },
        update: {
          $set: {
            connectCode: doc._id,
            displayName: doc.displayName,
            tag: doc.tag,
            gameCount: doc.gameCount,
            builtAt,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await Player.bulkWrite(batch);
      upserted += batch.length;
      batch = [];
      console.log(`Upserted: ${upserted}`);
    }
  }

  if (batch.length > 0) {
    await Player.bulkWrite(batch);
    upserted += batch.length;
  }

  // Players with no usable games left (e.g. removed duplicates) drop out. Guard:
  // only if every upserted row really carries this run's timestamp, so a failed
  // write can never wipe the table.
  const fresh = await Player.countDocuments({ builtAt });
  if (upserted === 0 || fresh !== upserted) {
    throw new Error(`Refusing to prune: upserted ${upserted}, rows stamped this run ${fresh}`);
  }
  const stale = await Player.deleteMany({ $or: [{ builtAt: { $lt: builtAt } }, { builtAt: { $exists: false } }] });
  console.log(`Removed ${stale.deletedCount} players with no usable games.`);

  const total = await Player.countDocuments();
  console.log(`Done. Upserted ${upserted} players. Total in collection: ${total}`);
  await mongoose.disconnect();
}

buildPlayers().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
