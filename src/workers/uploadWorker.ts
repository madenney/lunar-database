import { Job } from "../models/Job";
import { uploadToR2, deleteFromR2 } from "../services/r2";
import { cleanupJobTemp } from "../services/bundler";

let currentJobId: string | null = null;
let running = false;

async function isCancelled(jobId: string): Promise<boolean> {
  const job = await Job.findById(jobId).select("status").lean();
  return !job || job.status === "cancelled";
}

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

  try {
    // Uploading step
    job.progress = { step: "uploading", filesProcessed: 0, filesTotal: 1 };
    await job.save();

    const r2Key = `jobs/${jobId}.tar`;
    await uploadToR2(job.bundlePath!, r2Key);

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
      setTimeout(tick, hadWork ? 0 : intervalMs);
    } catch (err) {
      console.error("Uploader error:", (err as Error).message);
      setTimeout(tick, intervalMs);
    }
  };

  tick();
}

export function stopUploader(): void {
  running = false;
  console.log("Uploader worker stopped");
}
