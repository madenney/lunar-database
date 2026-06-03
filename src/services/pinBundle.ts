import { Job } from "../models/Job";
import { copyObject, deleteFromStorage } from "./storage";

export const EPHEMERAL_PREFIX = "jobs/";
export const ARCHIVE_PREFIX = "archive/";

/** Thrown for caller-facing failures (mapped to an HTTP status by the route). */
export class PinError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PinError";
  }
}

export interface PinResult {
  jobId: string;
  pinned: boolean;
  r2Key: string | null;
}

/** Swap the leading prefix segment of a storage key (e.g. jobs/x.zip -> archive/x.zip). */
function withPrefix(key: string, prefix: string): string {
  const slash = key.indexOf("/");
  const base = slash === -1 ? key : key.slice(slash + 1);
  return prefix + base;
}

/**
 * Pin a completed bundle: move its object to the no-expiry `archive/` prefix and
 * flag the job so storage cleanup leaves it alone. Idempotent.
 */
export async function pinBundle(jobId: string): Promise<PinResult> {
  const job = await Job.findById(jobId);
  if (!job) throw new PinError(404, "Job not found");
  if (job.status !== "completed" || !job.r2Key) {
    throw new PinError(400, "Only completed bundles with a live download can be pinned");
  }

  // Relocate to archive/ only if it isn't already there.
  if (!job.r2Key.startsWith(ARCHIVE_PREFIX)) {
    const destKey = withPrefix(job.r2Key, ARCHIVE_PREFIX);
    await copyObject(job.r2Key, destKey);
    await deleteFromStorage(job.r2Key);
    job.r2Key = destKey;
  }

  job.pinned = true;
  await job.save();
  return { jobId: job._id.toString(), pinned: true, r2Key: job.r2Key };
}

/**
 * Unpin a bundle: move its object back under the ephemeral `jobs/` prefix so the
 * lifecycle rule expires it normally, and clear the flag. Idempotent.
 */
export async function unpinBundle(jobId: string): Promise<PinResult> {
  const job = await Job.findById(jobId);
  if (!job) throw new PinError(404, "Job not found");

  if (job.r2Key && job.r2Key.startsWith(ARCHIVE_PREFIX)) {
    const destKey = withPrefix(job.r2Key, EPHEMERAL_PREFIX);
    await copyObject(job.r2Key, destKey);
    await deleteFromStorage(job.r2Key);
    job.r2Key = destKey;
  }

  job.pinned = false;
  await job.save();
  return { jobId: job._id.toString(), pinned: false, r2Key: job.r2Key };
}
