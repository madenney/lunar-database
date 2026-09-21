import { Job } from "../models/Job";

export interface CleanupResult {
  checked: number;
  cleaned: number;
  freedBytes: number;
  errors: number;
}

const DEFAULT_BATCH_SIZE = 1000;

/**
 * DB-only cleanup: nullify r2Key on expired jobs so downloadReady stays accurate.
 * Actual object deletion is handled by B2 lifecycle rules on the jobs/ prefix.
 *
 * Processes in bounded batches (L4) so a large backlog never loads every matching
 * job into memory at once. `batchSize` is injectable for tests.
 */
export async function cleanupExpiredJobs(
  maxAgeDays: number,
  dryRun = false,
  batchSize = DEFAULT_BATCH_SIZE
): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  // Completed jobs with a live storage key older than the lifecycle cutoff. Pinned
  // bundles live under archive/ and never expire.
  const filter = {
    status: "completed",
    r2Key: { $ne: null },
    pinned: { $ne: true },
    $or: [
      { lastDownloadedAt: { $ne: null, $lt: cutoff } },
      { lastDownloadedAt: null, completedAt: { $lt: cutoff } },
    ],
  };

  const result: CleanupResult = { checked: 0, cleaned: 0, freedBytes: 0, errors: 0 };

  if (dryRun) {
    // Count + sum in the DB — no document loading, so it's memory-safe at any size.
    const [agg] = await Job.aggregate([
      { $match: filter },
      { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: { $ifNull: ["$bundleSize", 0] } } } },
    ]);
    result.checked = result.cleaned = agg?.count ?? 0;
    result.freedBytes = agg?.bytes ?? 0;
    return result;
  }

  // Drain the backlog in batches. Nulling r2Key removes a job from the filter, so
  // each pass fetches the next set; we stop when a page is short or makes no
  // progress (e.g. every update in it errored — avoids re-fetching the same rows).
  for (;;) {
    const batch = await Job.find(filter).select("bundleSize").limit(batchSize).lean();
    if (batch.length === 0) break;

    let cleanedThisBatch = 0;
    for (const job of batch) {
      result.checked++;
      try {
        await Job.updateOne({ _id: job._id }, { $set: { r2Key: null } });
        result.cleaned++;
        cleanedThisBatch++;
        result.freedBytes += job.bundleSize ?? 0;
      } catch (err) {
        console.error(`Failed to clean up job ${job._id}:`, (err as Error).message);
        result.errors++;
      }
    }

    if (batch.length < batchSize || cleanedThisBatch === 0) break;
  }

  return result;
}
