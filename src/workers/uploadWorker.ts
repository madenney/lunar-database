import path from "path";
import { Job } from "../models/Job";
import { uploadToStorage, deleteFromStorage, classifyStorageError } from "../services/storage";
import { cleanupJobTemp } from "../services/bundler";
import { isCancelled } from "./utils";
import { config } from "../config";
import { sanitizeJobErrorMessage } from "../utils/sanitizeError";
import { queueGate, pauseForStorageCap, type Lane } from "../services/jobQueue";

// Two uploaders, mirroring the compressor lanes (services/jobQueue.ts).
const LANES: Lane[] = ["main", "fast"];
const currentJobIds: Record<Lane, string | null> = { main: null, fast: null };
let running = false;
const timers: Record<Lane, ReturnType<typeof setTimeout> | null> = { main: null, fast: null };

/** Network/TLS failures worth retrying (seen in production: EPROTO, ENETUNREACH, resets). */
const TRANSIENT = /EPROTO|ENETUNREACH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|EPIPE|timed? ?out/i;

export function isUploaderRunning(): boolean {
  return running;
}

export function getUploaderJobId(): string | null {
  return currentJobIds.main ?? currentJobIds.fast;
}

export async function processNextUpload(lane: Lane = "main"): Promise<boolean> {
  if (!(await queueGate())) return false;
  const job = await Job.findOneAndUpdate(
    lane === "fast" ? { status: "bundled", lane: "fast" } : { status: "bundled" },
    { $set: { status: "uploading", phaseStartedAt: new Date() }, $inc: { uploadAttempts: 1 } },
    { sort: { priority: 1, createdAt: 1 }, new: true }
  );

  if (!job) return false;

  const jobId = job._id.toString();
  currentJobIds[lane] = jobId;
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
    // A storage cap or a network blip isn't the job's fault: keep the bundle and
    // put the job back in line (pausing uploads for a cap) instead of failing it.
    const cap = classifyStorageError(err) === "cap";
    const retry = cap || (TRANSIENT.test(rawMsg) && (job.uploadAttempts ?? 1) < config.jobUploadMaxAttempts);
    if (retry) {
      const requeued = await Job.updateOne({ _id: jobId, status: "uploading" }, { status: "bundled", progress: null }).catch(() => null);
      if (requeued?.matchedCount) {
        if (cap) await pauseForStorageCap(`Upload of job ${jobId} refused: ${rawMsg}`);
        console.error(`Job ${jobId} upload ${cap ? "hit the storage cap" : "failed (will retry)"}:`, rawMsg);
        if (!cap && process.env.NODE_ENV !== "test") await new Promise((r) => setTimeout(r, 15_000));
        return true;
      }
    }
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
    currentJobIds[lane] = null;
  }

  return true;
}

export function startUploader(intervalMs = 5000): void {
  running = true;
  console.log("Uploader workers started (main + fast lanes)");

  for (const lane of LANES) {
    const tick = async () => {
      if (!running) return;
      try {
        const hadWork = await processNextUpload(lane);
        if (running) timers[lane] = setTimeout(tick, hadWork ? 500 : intervalMs);
      } catch (err) {
        console.error(`Uploader (${lane}) error:`, (err as Error).message);
        if (running) timers[lane] = setTimeout(tick, intervalMs);
      }
    };
    tick();
  }
}

export function stopUploader(): void {
  running = false;
  for (const lane of LANES) {
    if (timers[lane]) clearTimeout(timers[lane]!);
    timers[lane] = null;
  }
  console.log("Uploader workers stopped");
}
