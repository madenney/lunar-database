import fs from "fs";
import mongoose from "mongoose";
import { config } from "../config";
import { Replay } from "../models/Replay";

async function backfill() {
  await mongoose.connect(config.mongoUri);
  console.log("Connected to MongoDB");

  const total = await Replay.countDocuments({ fileSize: null });
  console.log(`${total} replays to backfill`);

  const BATCH = 1000;
  let updated = 0;
  let missing = 0;
  let cursor = Replay.find({ fileSize: null }).select("filePath").lean().cursor();

  let ops: { updateOne: { filter: { _id: any }; update: { $set: { fileSize: number } } } }[] = [];

  for await (const doc of cursor) {
    try {
      const stat = fs.statSync(doc.filePath);
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { fileSize: stat.size } },
        },
      });
    } catch {
      missing++;
    }

    if (ops.length >= BATCH) {
      await Replay.bulkWrite(ops);
      updated += ops.length;
      ops = [];
      console.log(`Updated: ${updated} / ${total} | Missing files: ${missing}`);
    }
  }

  if (ops.length > 0) {
    await Replay.bulkWrite(ops);
    updated += ops.length;
  }

  console.log(`Done. Updated: ${updated}, Missing files: ${missing}`);
  await mongoose.disconnect();
}

backfill().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
