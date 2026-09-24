import { Job } from "../models/Job";
import { cleanupJobTemp } from "./bundler";

// States where a worker actively holds a job. "bundled" is a queue state (waiting
// for the uploader) and is intentionally NOT reaped — a stuck uploader is a
// monitoring concern, not a per-job timeout.
const ACTIVE_STATES = ["processing", "bundling", "uploading"] as const;

/**
 * Fail jobs stuck in one worker phase longer than `stuckAfterMinutes` (M5), timed
 * from `phaseStartedAt` (set when compression or upload claims the job) so time
 * spent queued as "bundled" never counts against the upload. Jobs claimed before
 * that field existed fall back to `startedAt`. This is
 * a failsafe for a live worker whose current job wedged: the in-process timeout
 * only fires between operations, so a job blocked mid-operation would otherwise
 * sit "processing"/"uploading" forever until a restart.
 *
 * Each fail is an atomic, status-gated updateOne, so it can't clobber a job the
 * worker just finished or that a cancel just claimed. If a reaped upload later
 * "completes", the M1 conditional completion no-ops and deletes the orphan object.
 */
export async function reapStuckJobs(stuckAfterMinutes: number): Promise<{ reaped: number }> {
  const cutoff = new Date(Date.now() - stuckAfterMinutes * 60 * 1000);
  const stuck = await Job.find({
    status: { $in: ACTIVE_STATES },
    $or: [
      { phaseStartedAt: { $ne: null, $lt: cutoff } },
      { phaseStartedAt: null, startedAt: { $ne: null, $lt: cutoff } },
    ],
  })
    .select("_id status startedAt phaseStartedAt")
    .lean();

  let reaped = 0;
  for (const job of stuck) {
    const jobId = job._id.toString();
    const res = await Job.updateOne(
      { _id: job._id, status: job.status },
      { status: "failed", error: "Job exceeded the maximum runtime and was reaped", progress: null }
    );
    if (res.modifiedCount > 0) {
      cleanupJobTemp(jobId);
      reaped++;
      console.error(
        `[reaper] failed stuck job ${jobId} (was ${job.status}, phase started ${(job.phaseStartedAt ?? job.startedAt)?.toISOString()})`
      );
    }
  }
  return { reaped };
}
