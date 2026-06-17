import fs from "fs";
import path from "path";
import { Job } from "../models/Job";
import { Replay } from "../models/Replay";
import { buildReplaySearchQuery, buildSortedQuery } from "../services/replaySearchQuery";
import { createBundle, cleanupJobTemp } from "../services/bundler";
import { isCancelled } from "./utils";
import { config } from "../config";
import { sanitizeJobErrorMessage } from "../utils/sanitizeError";

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

    // Stream the matching replays from the filter (downloads are uncapped). A
    // cursor keeps memory bounded to one doc at a time as we accumulate file paths
    // up to the job's maxFiles/maxSizeMb limits (if any). When a limit is set we
    // read in the job's sort order so the bundle is the same first-N the user saw
    // in the UI; with no limit, order is irrelevant and we skip the sort cost.
    const maxFiles = job.filter.maxFiles != null && job.filter.maxFiles > 0 ? Number(job.filter.maxFiles) : Infinity;
    const maxBytes = job.filter.maxSizeMb != null && job.filter.maxSizeMb > 0 ? Number(job.filter.maxSizeMb) * 1024 * 1024 : Infinity;
    const ordered = maxFiles !== Infinity || maxBytes !== Infinity;

    let cursorQuery: Record<string, any>;
    let sortObj: Record<string, 1 | -1> | null = null;
    if (ordered) {
      const built = buildSortedQuery(job.filter);
      cursorQuery = built.query;
      sortObj = built.sortObj;
    } else {
      cursorQuery = buildReplaySearchQuery(job.filter);
    }

    let find = Replay.find(cursorQuery).select("filePath fileSize");
    if (sortObj) find = find.sort(sortObj);
    const cursor = find.lean().cursor();

    const filePaths: string[] = [];
    let rawSize = 0;
    for await (const r of cursor) {
      if (filePaths.length >= maxFiles) break;
      const size = (r as any).fileSize ?? 0;
      // Always include at least one file, then stop before exceeding the budget.
      if (filePaths.length > 0 && rawSize + size > maxBytes) break;
      const fp = path.join(resolvedRoot, (r as any).filePath);
      if (!fp.startsWith(resolvedRoot + path.sep)) continue; // guard path traversal
      filePaths.push(fp);
      rawSize += size;
    }
    await cursor.close();

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

    // replayIds is no longer materialised — a large job's ID array would exceed
    // MongoDB's 16MB per-document limit. The bundle is built straight from the
    // streamed filePaths, so we only record the count + total size.
    job.replayIds = [];
    job.replayCount = filePaths.length;
    job.estimatedSize = rawSize;

    // Bundling step (gather cached .slpz, compress any misses)
    job.status = "bundling";
    job.progress = { step: "bundling", filesProcessed: 0, filesTotal: filePaths.length };
    await job.save();

    const { zipPath, size, cacheHits } = await createBundle(filePaths, jobId, (processed, total) => {
      // Fire-and-forget progress updates (don't await to avoid slowing the pipeline)
      Job.updateOne(
        { _id: job._id, status: "bundling" },
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

    // Mark as bundled — uploader will pick it up
    job.status = "bundled";
    job.bundlePath = zipPath;
    job.bundleSize = size;
    job.progress = null;
    await job.save();

    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(
      `Job ${jobId} bundled: ${filePaths.length} files ` +
      `(${cacheHits} from slpz cache, ${filePaths.length - cacheHits} fresh), ` +
      `${(size / 1024 / 1024).toFixed(1)}MB in ${elapsed}s`
    );
  } catch (err) {
    const rawMsg = (err as Error).message;
    const safeMsg = sanitizeJobErrorMessage(rawMsg);
    try {
      job.status = "failed";
      job.error = safeMsg;
      job.progress = null;
      await job.save();
    } catch (saveErr) {
      console.error(`Failed to save error state for job ${jobId}:`, (saveErr as Error).message);
      await Job.updateOne(
        { _id: jobId },
        { status: "failed", error: safeMsg, progress: null }
      ).catch(() => {});
    }

    cleanupJobTemp(jobId);

    console.error(`Job ${jobId} compression failed:`, rawMsg);
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
