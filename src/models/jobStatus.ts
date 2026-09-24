/**
 * Job lifecycle statuses. Part of the cross-app contract: the website's job UI
 * and scripts/test/api-errors.test.mjs read this list, so keep it import-free.
 *
 * pending -> processing -> bundling -> bundled -> uploading -> completed
 * Any active status can end in failed or cancelled.
 */
export const JOB_STATUSES = [
  "pending",
  "processing",
  "bundling",
  "bundled",
  "uploading",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that still hold a worker slot or queue position. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["pending", "processing", "bundling", "bundled", "uploading"];
