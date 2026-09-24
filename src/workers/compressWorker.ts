import fs from "fs";
import path from "path";
import { Job } from "../models/Job";
import { Replay } from "../models/Replay";
import { resolveSelection } from "../services/replaySearchQuery";
import { createBundle, cleanupJobTemp, BundleEntry } from "../services/bundler";
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
    { $set: { status: "processing", startedAt: new Date(), phaseStartedAt: new Date() } },
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

    const { query: cursorQuery, sortObj } = await resolveSelection(job.filter);

    let find = Replay.find(cursorQuery).select("filePath fileSize fileHash");
    if (ordered) find = find.sort(sortObj);
    const cursor = find.lean().cursor();

    const entries: BundleEntry[] = [];
    let rawSize = 0;
    for await (const r of cursor) {
      if (entries.length >= maxFiles) break;
      const size = (r as any).fileSize ?? 0;
      // Always include at least one file, then stop before exceeding the budget.
      if (entries.length > 0 && rawSize + size > maxBytes) break;
      const fp = path.join(resolvedRoot, (r as any).filePath);
      if (!fp.startsWith(resolvedRoot + path.sep)) continue; // guard path traversal
      entries.push({ filePath: fp, replayId: String((r as any)._id), fileHash: (r as any).fileHash });
      rawSize += size;
    }
    await cursor.close();

    if (entries.length === 0) {
      await Job.updateOne(
        { _id: jobId, status: "processing" },
        { status: "failed", error: "No replays matched the filter" }
      );
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

    // Move processing → bundling atomically (updateOne, not job.save, so a stale
    // in-memory status can't clobber a concurrent cancel — M1). If it no longer
    // matches, a cancel raced us; abort before doing the expensive bundle.
    // replayIds stays [] — a large job's ID array would exceed the 16MB doc limit.
    const started = await Job.updateOne(
      { _id: jobId, status: "processing" },
      {
        status: "bundling",
        replayIds: [],
        replayCount: entries.length,
        estimatedSize: rawSize,
        progress: { step: "bundling", filesProcessed: 0, filesTotal: entries.length },
      }
    );
    if (started.matchedCount === 0) {
      console.log(`Job ${jobId} no longer processing (cancelled?) — aborting before bundle`);
      return true;
    }

    const { zipPath, size, cacheHits } = await createBundle(entries, jobId, (processed, total) => {
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

    // Mark bundled only if still bundling — otherwise a cancel raced us; discard
    // the freshly built bundle instead of letting the uploader pick it up and
    // bill B2 for a cancelled job (M1).
    const bundled = await Job.updateOne(
      { _id: jobId, status: "bundling" },
      { status: "bundled", bundlePath: zipPath, bundleSize: size, progress: null }
    );
    if (bundled.matchedCount === 0) {
      console.log(`Job ${jobId} no longer bundling (cancelled?) — discarding bundle`);
      cleanupJobTemp(jobId);
      return true;
    }

    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(
      `Job ${jobId} bundled: ${entries.length} files ` +
      `(${cacheHits} from slpz cache, ${entries.length - cacheHits} fresh), ` +
      `${(size / 1024 / 1024).toFixed(1)}MB in ${elapsed}s`
    );
  } catch (err) {
    const rawMsg = (err as Error).message;
    const safeMsg = sanitizeJobErrorMessage(rawMsg);
    // Mark failed only if still in this worker's active states — never clobber a
    // cancel/bundled that already landed (M1).
    await Job.updateOne(
      { _id: jobId, status: { $in: ["processing", "bundling"] } },
      { status: "failed", error: safeMsg, progress: null }
    ).catch((saveErr) =>
      console.error(`Failed to save error state for job ${jobId}:`, (saveErr as Error).message)
    );

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
