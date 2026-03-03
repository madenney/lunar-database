import mongoose from "mongoose";
import { connectDb } from "../db";
import { cleanupStaleR2Objects } from "../services/r2Cleanup";
import { config } from "../config";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  let maxAgeDays = config.r2CleanupAfterDays;
  const daysIdx = args.indexOf("--days");
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    maxAgeDays = parseInt(args[daysIdx + 1], 10);
    if (isNaN(maxAgeDays) || maxAgeDays < 1) {
      console.error("--days must be a positive integer");
      process.exit(1);
    }
  }

  await connectDb();

  console.log(`R2 Cleanup ${dryRun ? "(DRY RUN)" : ""}`);
  console.log(`  Max age: ${maxAgeDays} days`);
  console.log("");

  const result = await cleanupStaleR2Objects(maxAgeDays, dryRun);

  const freedMb = (result.freedBytes / 1024 / 1024).toFixed(1);
  console.log(`  Stale objects found: ${result.checked}`);
  console.log(`  ${dryRun ? "Would delete" : "Deleted"}: ${result.cleaned}`);
  console.log(`  ${dryRun ? "Would free" : "Freed"}: ${freedMb} MB`);
  if (result.errors > 0) {
    console.log(`  Errors: ${result.errors}`);
  }

  console.log("");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
