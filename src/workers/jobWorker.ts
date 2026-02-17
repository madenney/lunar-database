import { Job } from "../models/Job";
import { Replay } from "../models/Replay";
import { buildReplayQuery } from "../services/replayQuery";
import { createBundle, cleanupJobTemp } from "../services/bundler";
import { uploadToR2, getPresignedDownloadUrl } from "../services/r2";
import { config } from "../config";

export async function processNextJob(): Promise<boolean> {
  const job = await Job.findOneAndUpdate(
    { status: "pending" },
    { status: "processing" },
    { sort: { createdAt: 1 }, new: true }
  );

  if (!job) return false;

  const jobId = job._id.toString();

  try {
    // Build query from filter
    const query = buildReplayQuery(job.filter);
    const replays = await Replay.find(query).select("filePath fileSize").lean();
    const filePaths = replays.map((r) => r.filePath);

    if (filePaths.length === 0) {
      job.status = "failed";
      job.error = "No replays matched the filter";
      await job.save();
      return true;
    }

    if (filePaths.length > config.jobMaxReplays) {
      job.status = "failed";
      job.error = `Too many replays (${filePaths.length}). Maximum is ${config.jobMaxReplays}.`;
      await job.save();
      return true;
    }

    job.replayIds = replays.map((r) => r._id);
    job.replayCount = replays.length;
    job.estimatedSize = replays.reduce((sum, r) => sum + (r.fileSize || 0), 0);

    // Compressing step
    job.status = "compressing";
    job.progress = { step: "compressing", filesProcessed: 0, filesTotal: filePaths.length };
    await job.save();

    const { tarPath, size } = await createBundle(filePaths, jobId, (processed, total) => {
      // Fire-and-forget progress updates (don't await to avoid slowing the pipeline)
      Job.updateOne(
        { _id: job._id },
        { "progress.filesProcessed": processed, "progress.filesTotal": total }
      ).exec();
    });

    // Uploading step
    job.status = "uploading";
    job.progress = { step: "uploading", filesProcessed: 0, filesTotal: 1 };
    await job.save();

    const r2Key = `jobs/${jobId}.tar`;
    await uploadToR2(tarPath, r2Key);

    // Generate presigned URL
    const expirySeconds = config.jobBundleExpiryHours * 60 * 60;
    const downloadUrl = await getPresignedDownloadUrl(r2Key, expirySeconds);

    job.status = "completed";
    job.bundlePath = tarPath;
    job.bundleSize = size;
    job.r2Key = r2Key;
    job.downloadUrl = downloadUrl;
    job.expiresAt = new Date(Date.now() + expirySeconds * 1000);
    job.progress = null;
    job.completedAt = new Date();
    await job.save();

    // Clean up local temp files
    cleanupJobTemp(jobId);

    console.log(
      `Job ${jobId} completed: ${filePaths.length} files, ${(size / 1024 / 1024).toFixed(1)}MB compressed`
    );
  } catch (err) {
    job.status = "failed";
    job.error = (err as Error).message;
    job.progress = null;
    await job.save();

    // Clean up temp files on failure
    cleanupJobTemp(jobId);

    console.error(`Job ${jobId} failed:`, (err as Error).message);
  }

  return true;
}

let running = false;

export function startWorker(intervalMs = 5000): void {
  running = true;
  console.log("Job worker started");

  const tick = async () => {
    if (!running) return;
    try {
      const hadWork = await processNextJob();
      // If there was work, check again immediately; otherwise wait
      setTimeout(tick, hadWork ? 0 : intervalMs);
    } catch (err) {
      console.error("Worker error:", (err as Error).message);
      setTimeout(tick, intervalMs);
    }
  };

  tick();
}

export function stopWorker(): void {
  running = false;
}
