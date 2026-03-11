import mongoose from "mongoose";
import { connectDb } from "../db";
import { cleanupExpiredJobs } from "../services/storageCleanup";
import { config } from "../config";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  let maxAgeDays = config.storageCleanupAfterDays;
  const daysIdx = args.indexOf("--days");
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    maxAgeDays = parseInt(args[daysIdx + 1], 10);
    if (isNaN(maxAgeDays) || maxAgeDays < 1) {
      console.error("--days must be a positive integer");
      process.exit(1);
    }
  }

  await connectDb();

  console.log(`Storage Cleanup ${dryRun ? "(DRY RUN)" : ""}`);
  console.log(`  Max age: ${maxAgeDays} days`);
  console.log("");

  const result = await cleanupExpiredJobs(maxAgeDays, dryRun);

  const freedMb = (result.freedBytes / 1024 / 1024).toFixed(1);
  console.log(`  Expired jobs found: ${result.checked}`);
  console.log(`  ${dryRun ? "Would clear" : "Cleared"}: ${result.cleaned}`);
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
