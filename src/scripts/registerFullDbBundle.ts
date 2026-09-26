/**
 * Register the pre-built whole-database archive as a pinned, publicly-downloadable
 * bundle (a completed Job) pointing at b2:lm-replays/archive/lunar_db_full.zip.
 *
 * Idempotent — uses a FIXED _id so the jobId is stable across re-runs / DB restores
 * (so the frontend can hard-code it). Called by scripts/full-db/rebuild.sh after a
 * new snapshot is uploaded, with that snapshot's facts:
 *
 *   npm run register-full-db -- --size BYTES --replays N --snapshot ISO_DATE
 */
import mongoose from "mongoose";
import { connectDb } from "../db";
import { Job } from "../models/Job";

const FULL_DB_ID = new mongoose.Types.ObjectId("a11db000a11db000a11db000"); // stable, memorable
const FULL_DB_KEY = "archive/lunar_db_full.zip";

function option(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing ${name} (usage: --size BYTES --replays N --snapshot ISO_DATE)`);
  return value;
}

async function main() {
  const bundleSize = Number(option("--size"));
  const replayCount = Number(option("--replays"));
  const snapshotAt = new Date(option("--snapshot"));
  if (!Number.isSafeInteger(bundleSize) || bundleSize <= 0) throw new Error("--size must be a positive byte count");
  if (!Number.isSafeInteger(replayCount) || replayCount <= 0) throw new Error("--replays must be a positive count");
  if (Number.isNaN(snapshotAt.getTime())) throw new Error("--snapshot must be a date");

  await connectDb();
  await Job.updateOne(
    { _id: FULL_DB_ID },
    {
      $set: {
        status: "completed",
        pinned: true,
        isFullDb: true,
        r2Key: FULL_DB_KEY,
        bundleSize,
        replayCount,
        totalMatched: replayCount,
        snapshotAt,
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
  console.log("  snapshotAt: ", job?.snapshotAt?.toISOString());
  console.log("  pinned:     ", job?.pinned, "| isFullDb:", job?.isFullDb, "| status:", job?.status);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
