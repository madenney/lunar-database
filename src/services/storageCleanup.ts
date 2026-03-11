import { Job } from "../models/Job";

export interface CleanupResult {
  checked: number;
  cleaned: number;
  freedBytes: number;
  errors: number;
}

/**
 * DB-only cleanup: nullify r2Key on expired jobs so downloadReady stays accurate.
 * Actual object deletion is handled by B2 lifecycle rules on the jobs/ prefix.
 */
export async function cleanupExpiredJobs(
  maxAgeDays: number,
  dryRun = false
): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  // Find completed jobs with storage keys older than the lifecycle cutoff
  const staleJobs = await Job.find({
    status: "completed",
    r2Key: { $ne: null },
    $or: [
      { lastDownloadedAt: { $ne: null, $lt: cutoff } },
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
      // Just null out the key — B2 lifecycle rules handle the actual object deletion
      await Job.updateOne({ _id: job._id }, { $set: { r2Key: null } });
      result.cleaned++;
      result.freedBytes += job.bundleSize ?? 0;
    } catch (err) {
      console.error(`Failed to clean up job ${job._id}:`, (err as Error).message);
      result.errors++;
    }
  }

  return result;
}
