import { Job } from "../models/Job";
import { deleteFromR2 } from "./r2";

export interface CleanupResult {
  checked: number;
  cleaned: number;
  freedBytes: number;
  errors: number;
}

export async function cleanupStaleR2Objects(
  maxAgeDays: number,
  dryRun = false
): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  // Find completed jobs with R2 objects where the most recent activity is older than cutoff.
  // "Most recent activity" = lastDownloadedAt if ever downloaded, otherwise completedAt.
  const staleJobs = await Job.find({
    status: "completed",
    r2Key: { $ne: null },
    $or: [
      // Downloaded before, but last download is stale
      { lastDownloadedAt: { $ne: null, $lt: cutoff } },
      // Never downloaded, and completed before cutoff
      { lastDownloadedAt: null, completedAt: { $lt: cutoff } },
    ],
  })
    .select("r2Key bundleSize lastDownloadedAt completedAt")
    .lean();

  const result: CleanupResult = {
    checked: staleJobs.length,
    cleaned: 0,
    freedBytes: 0,
    errors: 0,
  };

  for (const job of staleJobs) {
    if (dryRun) {
      result.cleaned++;
      result.freedBytes += job.bundleSize ?? 0;
      continue;
    }

    try {
      await deleteFromR2(job.r2Key!);
      await Job.updateOne({ _id: job._id }, { $set: { r2Key: null } });
      result.cleaned++;
      result.freedBytes += job.bundleSize ?? 0;
    } catch (err) {
      console.error(`Failed to clean up R2 object for job ${job._id}:`, (err as Error).message);
      result.errors++;
    }
  }

  return result;
}
