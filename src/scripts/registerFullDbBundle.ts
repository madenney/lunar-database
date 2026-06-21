/**
 * Register the pre-built whole-database archive as a pinned, publicly-downloadable
 * bundle (a completed Job) pointing at b2:lm-replays/archive/lunar_db_full.zip.
 *
 * Idempotent — uses a FIXED _id so the jobId is stable across re-runs / DB restores
 * (so the frontend can hard-code it). Re-running just refreshes the fields.
 *
 *   npx ts-node src/scripts/registerFullDbBundle.ts
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Job } from "../models/Job";
import { Replay } from "../models/Replay";

const FULL_DB_ID = new mongoose.Types.ObjectId("a11db000a11db000a11db000"); // stable, memorable
const FULL_DB_KEY = "archive/lunar_db_full.zip";
const FULL_DB_SIZE = 1295550885100; // bytes, verified against the B2 object

async function main() {
  await connectDb();
  const replayCount = await Replay.estimatedDocumentCount();

  await Job.updateOne(
    { _id: FULL_DB_ID },
    {
      $set: {
        status: "completed",
        pinned: true,
        isFullDb: true,
        r2Key: FULL_DB_KEY,
        bundleSize: FULL_DB_SIZE,
        replayCount,
        totalMatched: replayCount,
        filter: {},            // empty filter = entire database; UI labels via the fullDb marker
        createdBy: null,       // public/system bundle (pinned ⇒ no ownership check on download)
        completedAt: new Date(),
        error: null,
        progress: null,
      },
    },
    { upsert: true }
  );

  const job = await Job.findById(FULL_DB_ID).lean();
  console.log("Full-DB bundle registered:");
  console.log("  jobId:      ", FULL_DB_ID.toString());
  console.log("  r2Key:      ", job?.r2Key);
  console.log("  bundleSize: ", job?.bundleSize);
  console.log("  replayCount:", job?.replayCount?.toLocaleString());
  console.log("  pinned:     ", job?.pinned, "| isFullDb:", (job as any)?.isFullDb, "| status:", job?.status);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
