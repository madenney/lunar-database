import path from "path";
import { Job } from "../models/Job";
import { uploadToR2, deleteFromR2 } from "../services/r2";
import { cleanupJobTemp } from "../services/bundler";
import { isCancelled } from "./utils";
import { config } from "../config";

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
    { status: "compressed" },
    { status: "uploading" },
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

    // Uploading step
    const totalBytes = job.bundleSize ?? 0;
    job.progress = { step: "uploading", filesProcessed: 0, filesTotal: 1, bytesUploaded: 0, bytesTotal: totalBytes };
    await job.save();

    const r2Key = `jobs/${jobId}.tar`;
    let lastReportedPct = 0;
    await uploadToR2(job.bundlePath, r2Key, (loaded, total) => {
      const pct = total > 0 ? Math.floor((loaded / total) * 100) : 0;
      if (pct >= lastReportedPct + 1) {
        lastReportedPct = pct;
        Job.updateOne(
          { _id: jobId },
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
      await deleteFromR2(r2Key).catch((err) =>
        console.error(`Failed to delete R2 key ${r2Key}:`, err.message)
      );
      cleanupJobTemp(jobId);
      return true;
    }

    job.status = "completed";
    job.r2Key = r2Key;
    job.progress = null;
    job.completedAt = new Date();
    await job.save();

    // Clean up local temp files
    cleanupJobTemp(jobId);

    console.log(
      `Job ${jobId} uploaded: ${(job.bundleSize! / 1024 / 1024).toFixed(1)}MB to R2`
    );
  } catch (err) {
    try {
      job.status = "failed";
      job.error = (err as Error).message;
      job.progress = null;
      await job.save();
    } catch (saveErr) {
      console.error(`Failed to save error state for job ${jobId}:`, (saveErr as Error).message);
      await Job.updateOne(
        { _id: jobId },
        { status: "failed", error: (err as Error).message, progress: null }
      ).catch(() => {});
    }

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
