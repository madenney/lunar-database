import fs from "fs";
import path from "path";
import { Job } from "../models/Job";
import { Replay } from "../models/Replay";
import { buildReplaySearchQuery } from "../services/replaySearchQuery";
import { createBundle, cleanupJobTemp } from "../services/bundler";
import { applyReplayLimits } from "../utils/applyReplayLimits";
import { isCancelled } from "./utils";
import { config } from "../config";

let currentJobId: string | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isCompressorRunning(): boolean {
  return running;
}

export function getCompressorJobId(): string | null {
  return currentJobId;
}

export async function processNextCompression(): Promise<boolean> {
  const job = await Job.findOneAndUpdate(
    { status: "pending" },
    { status: "processing", startedAt: new Date() },
    { sort: { priority: 1, createdAt: 1 }, new: true }
  );

  if (!job) return false;

  const jobId = job._id.toString();
  currentJobId = jobId;
  const jobStartTime = Date.now();
  const jobTimeoutMs = config.jobTimeoutMinutes * 60 * 1000;

  /** Check if the overall job timeout has been exceeded */
  function isTimedOut(): boolean {
    return Date.now() - jobStartTime > jobTimeoutMs;
  }

  try {
    // Verify SLP root directory is accessible (e.g. drive is mounted)
    const resolvedRoot = path.resolve(config.slpRootDir);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`SLP root directory not found: ${resolvedRoot} — is the drive mounted?`);
    }

    // Build query from filter
    const query = buildReplaySearchQuery(job.filter);
    const allReplays = await Replay.find(query).select("filePath fileSize").lean();
    const replays = applyReplayLimits(allReplays, job.filter.maxFiles, job.filter.maxSizeMb);
    const filePaths = replays
      .map((r) => r.filePath)
      .filter((fp) => path.resolve(fp).startsWith(resolvedRoot + path.sep));

    if (filePaths.length === 0) {
      job.status = "failed";
      job.error = "No replays matched the filter";
      await job.save();
      return true;
    }

    // Cancellation checkpoint 1: after query
    if (await isCancelled(jobId)) {
      console.log(`Job ${jobId} cancelled after query`);
      return true;
    }

    if (isTimedOut()) {
      throw new Error(`Job timed out after ${config.jobTimeoutMinutes} minutes (during query phase)`);
    }

    job.replayIds = replays.map((r) => r._id);
    job.replayCount = replays.length;
    job.estimatedSize = replays.reduce((sum, r) => sum + (r.fileSize || 0), 0);

    // Compressing step
    job.status = "compressing";
    job.progress = { step: "compressing", filesProcessed: 0, filesTotal: filePaths.length };
    await job.save();

    const { zipPath, size } = await createBundle(filePaths, jobId, (processed, total) => {
      // Fire-and-forget progress updates (don't await to avoid slowing the pipeline)
      Job.updateOne(
        { _id: job._id, status: "compressing" },
        { "progress.filesProcessed": processed, "progress.filesTotal": total }
      ).exec().catch(() => {}); // progress is best-effort
    });

    if (isTimedOut()) {
      cleanupJobTemp(jobId);
      throw new Error(`Job timed out after ${config.jobTimeoutMinutes} minutes (after compression)`);
    }

    // Cancellation checkpoint 2: after compression
    if (await isCancelled(jobId)) {
      console.log(`Job ${jobId} cancelled after compression`);
      cleanupJobTemp(jobId);
      return true;
    }

    // Mark as compressed — uploader will pick it up
    job.status = "compressed";
    job.bundlePath = zipPath;
    job.bundleSize = size;
    job.progress = null;
    await job.save();

    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(
      `Job ${jobId} compressed: ${filePaths.length} files, ${(size / 1024 / 1024).toFixed(1)}MB in ${elapsed}s`
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

    console.error(`Job ${jobId} compression failed:`, (err as Error).message);
  } finally {
    currentJobId = null;
  }

  return true;
}

export function startCompressor(intervalMs = 5000): void {
  running = true;
  console.log("Compressor worker started");

  const tick = async () => {
    if (!running) return;
    try {
      const hadWork = await processNextCompression();
      if (running) timer = setTimeout(tick, hadWork ? 500 : intervalMs);
    } catch (err) {
      console.error("Compressor error:", (err as Error).message);
      if (running) timer = setTimeout(tick, intervalMs);
    }
  };

  tick();
}

export function stopCompressor(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("Compressor worker stopped");
}
