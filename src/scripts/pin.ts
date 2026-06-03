import mongoose from "mongoose";
import { connectDb } from "../db";
import { pinBundle, unpinBundle, PinError } from "../services/pinBundle";

/**
 * Pin or unpin a completed bundle so it survives (or resumes) storage expiry.
 *   npm run pin <jobId>            # make permanent (move to archive/)
 *   npm run pin <jobId> --unpin    # back to ephemeral (move to jobs/)
 */
async function main() {
  const args = process.argv.slice(2);
  const unpin = args.includes("--unpin");
  const jobId = args.find((a) => !a.startsWith("--"));

  if (!jobId) {
    console.error("Usage: npm run pin <jobId> [--unpin]");
    process.exit(1);
  }

  await connectDb();
  try {
    const result = unpin ? await unpinBundle(jobId) : await pinBundle(jobId);
    console.log(`${unpin ? "Unpinned" : "Pinned"} job ${result.jobId}`);
    console.log(`  pinned: ${result.pinned}`);
    console.log(`  r2Key:  ${result.r2Key}`);
  } catch (err) {
    if (err instanceof PinError) {
      console.error(`Error (${err.status}): ${err.message}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    throw err;
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
