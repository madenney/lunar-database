import mongoose from "mongoose";
import { config } from "../config";
import { Replay } from "../models/Replay";
import { Player } from "../models/Player";

async function buildPlayers() {
  await mongoose.connect(config.mongoUri);
  console.log("Connected to MongoDB");

  console.log("Aggregating players from replays...");
  const pipeline = [
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

  const total = await Player.countDocuments();
  console.log(`Done. Upserted ${upserted} players. Total in collection: ${total}`);
  await mongoose.disconnect();
}

buildPlayers().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
