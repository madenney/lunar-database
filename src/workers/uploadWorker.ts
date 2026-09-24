import path from "path";
import { Job } from "../models/Job";
import { uploadToStorage, deleteFromStorage } from "../services/storage";
import { cleanupJobTemp } from "../services/bundler";
import { isCancelled } from "./utils";
import { config } from "../config";
import { sanitizeJobErrorMessage } from "../utils/sanitizeError";

let currentJobId: string | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isUploaderRunning(): boolean {
  return running;
}

export function getUploaderJobId(): string | null {
  return currentJobId;
}

export async function processNextUpload(): Promise<boolean> {
  const job = await Job.findOneAndUpdate(
    { status: "bundled" },
    { $set: { status: "uploading", phaseStartedAt: new Date() } },
    { sort: { priority: 1, createdAt: 1 }, new: true }
  );

  if (!job) return false;

  const jobId = job._id.toString();
  currentJobId = jobId;
  const jobStartTime = Date.now();
  const jobTimeoutMs = config.jobTimeoutMinutes * 60 * 1000;

  try {
    if (!job.bundlePath) {
      throw new Error("Job has no bundlePath");
    }

    const resolvedBundle = path.resolve(job.bundlePath);
    const resolvedTempDir = path.resolve(config.jobTempDir);
    if (!resolvedBundle.startsWith(resolvedTempDir + path.sep)) {
      throw new Error("bundlePath is outside jobTempDir");
    }

    // Uploading step. Use updateOne (not job.save) so we write only `progress` —
    // a full-doc save would rewrite `status` from the stale in-memory doc and
    // could clobber a concurrent cancel (M1). Same reasoning for every write below.
    const totalBytes = job.bundleSize ?? 0;
    await Job.updateOne(
      { _id: jobId, status: "uploading" },
      { progress: { step: "uploading", filesProcessed: 0, filesTotal: 1, bytesUploaded: 0, bytesTotal: totalBytes } }
    );

    const r2Key = `jobs/${jobId}.zip`;
    let lastReportedPct = 0;
    await uploadToStorage(job.bundlePath, r2Key, (loaded, total) => {
      const pct = total > 0 ? Math.floor((loaded / total) * 100) : 0;
      if (pct >= lastReportedPct + 1) {
        lastReportedPct = pct;
        Job.updateOne(
          { _id: jobId, status: "uploading" },
          { "progress.bytesUploaded": loaded, "progress.bytesTotal": total }
        ).catch(() => {});
      }
    });

    if (Date.now() - jobStartTime > jobTimeoutMs) {
      throw new Error(`Job timed out after ${config.jobTimeoutMinutes} minutes (during upload)`);
    }

    // Cancellation checkpoint: after upload
    if (await isCancelled(jobId)) {
      console.log(`Job ${jobId} cancelled after upload, deleting R2 object`);
      await deleteFromStorage(r2Key).catch((err) =>
        console.error(`Failed to delete storage key ${r2Key}:`, err.message)
      );
      cleanupJobTemp(jobId);
      return true;
    }

    // Complete atomically, only if still uploading. If a cancel landed in the race
    // window since the checkpoint above, this no-ops and we tear down rather than
    // resurrecting the job with a live (billed) B2 object (M1).
    const completed = await Job.updateOne(
      { _id: jobId, status: "uploading" },
      { status: "completed", r2Key, progress: null, completedAt: new Date() }
    );
    if (completed.matchedCount === 0) {
      console.log(`Job ${jobId} no longer uploading (cancelled?) — deleting R2 object`);
      await deleteFromStorage(r2Key).catch((err) =>
        console.error(`Failed to delete storage key ${r2Key}:`, err.message)
      );
      cleanupJobTemp(jobId);
      return true;
    }

    // Clean up local temp files
    cleanupJobTemp(jobId);

    console.log(
      `Job ${jobId} uploaded: ${(job.bundleSize! / 1024 / 1024).toFixed(1)}MB to B2`
    );
  } catch (err) {
    const rawMsg = (err as Error).message;
    const safeMsg = sanitizeJobErrorMessage(rawMsg);
    // Mark failed only if still uploading — never clobber a cancel/complete that
    // already landed (M1).
    await Job.updateOne(
      { _id: jobId, status: "uploading" },
      { status: "failed", error: safeMsg, progress: null }
    ).catch((saveErr) =>
      console.error(`Failed to save error state for job ${jobId}:`, (saveErr as Error).message)
    );

    cleanupJobTemp(jobId);

    console.error(`Job ${jobId} upload failed:`, (err as Error).message);
  } finally {
    currentJobId = null;
  }

  return true;
}

export function startUploader(intervalMs = 5000): void {
  running = true;
  console.log("Uploader worker started");

  const tick = async () => {
    if (!running) return;
    try {
      const hadWork = await processNextUpload();
      if (running) timer = setTimeout(tick, hadWork ? 500 : intervalMs);
    } catch (err) {
      console.error("Uploader error:", (err as Error).message);
      if (running) timer = setTimeout(tick, intervalMs);
    }
  };

  tick();
}

export function stopUploader(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("Uploader worker stopped");
}
