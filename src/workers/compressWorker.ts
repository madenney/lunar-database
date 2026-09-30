import fs from "fs";
import path from "path";
import { Job } from "../models/Job";
import { Replay } from "../models/Replay";
import { resolveSelection } from "../services/replaySearchQuery";
import { streamBundle, BundleStopped, BundleEntry } from "../services/bundler";
import { deleteFromStorage, classifyStorageError } from "../services/storage";
import { isCancelled } from "./utils";
import { config } from "../config";
import { sanitizeJobErrorMessage } from "../utils/sanitizeError";
import { queueGate, pauseForStorageCap, type Lane } from "../services/jobQueue";
import { clipSearchReplayIds } from "../services/clipSearch";

/** Network/TLS failures worth retrying (seen in production: EPROTO, ENETUNREACH, resets). */
const TRANSIENT = /EPROTO|ENETUNREACH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|EPIPE|timed? ?out/i;

// Two compressors (services/jobQueue.ts): "main" takes the next job of any size,
// "fast" only small ones, so one huge bundle can't hold up everyone behind it.
const LANES: Lane[] = ["main", "fast"];
const currentJobIds: Record<Lane, string | null> = { main: null, fast: null };
let running = false;
const timers: Record<Lane, ReturnType<typeof setTimeout> | null> = { main: null, fast: null };

export function isCompressorRunning(): boolean {
  return running;
}

export function getCompressorJobId(): string | null {
  return currentJobIds.main ?? currentJobIds.fast;
}

export function getCompressorJobIds(): Record<Lane, string | null> {
  return { ...currentJobIds };
}

export async function processNextCompression(lane: Lane = "main"): Promise<boolean> {
  if (!(await queueGate())) return false;
  const job = await Job.findOneAndUpdate(
    lane === "fast" ? { status: "pending", lane: "fast" } : { status: "pending" },
    { $set: { status: "processing", startedAt: new Date(), phaseStartedAt: new Date() } },
    { sort: { priority: 1, createdAt: 1 }, new: true }
  );

  if (!job) return false;

  const jobId = job._id.toString();
  currentJobIds[lane] = jobId;
  const jobStartTime = Date.now();
  // Big bundles take as long as the upload does: allow at least the configured
  // timeout, and more for large ones (at a pessimistic 1 MiB/s, a sixth of the
  // measured home upload), so no legitimate job is cut off.
  const estBundleBytes = Math.round((job.estimatedSize ?? 0) / 8) + (job.replayCount ?? 0) * 128;
  const jobTimeoutMs = Math.max(config.jobTimeoutMinutes * 60 * 1000, (estBundleBytes / (1024 * 1024)) * 1000);
  await Job.updateOne({ _id: job._id }, { deadlineAt: new Date(jobStartTime + jobTimeoutMs) });

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

    const entries: BundleEntry[] = [];
    let rawSize = 0;
    /** Add one replay; false once a limit is reached. */
    const take = (r: any): boolean => {
      if (entries.length >= maxFiles) return false;
      const size = r.fileSize ?? 0;
      // Always include at least one file, then stop before exceeding the budget.
      if (entries.length > 0 && rawSize + size > maxBytes) return false;
      const fp = path.join(resolvedRoot, r.filePath);
      if (!fp.startsWith(resolvedRoot + path.sep)) return true; // guard path traversal
      entries.push({ filePath: fp, replayId: String(r._id), fileHash: r.fileHash });
      rawSize += size;
      return true;
    };

    if (job.filter.clipSearch) {
      // The games behind a clip search, found in batches (any number of them).
      outer: for await (const ids of clipSearchReplayIds(job.filter.clipSearch)) {
        const docs = await Replay.find({ _id: { $in: ids }, usable: true }).select("filePath fileSize fileHash").lean();
        for (const r of docs) if (!take(r)) break outer;
      }
    } else {
      const { query: cursorQuery, sortObj, hint } = await resolveSelection(job.filter);
      let find = Replay.find(cursorQuery).select("filePath fileSize fileHash");
      if (hint) find = find.hint(hint);
      if (ordered) find = find.sort(sortObj);
      const cursor = find.lean().cursor();
      for await (const r of cursor) if (!take(r)) break;
      await cursor.close();
    }

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

    // Build and upload in one pass: the zip streams straight to storage, so a
    // bundle of any size needs no room on local disk.
    const key = `jobs/${jobId}.zip`;
    const expectedBytes = Math.round(rawSize / 8) + entries.length * 128;
    let timedOut = false;
    let lastProgressWrite = 0;
    const { size, cacheHits, files, rawFallbacks } = await streamBundle(entries, jobId, key, expectedBytes, {
      onProgress: (added, total, uploaded) => {
        // Best-effort and throttled; never slows the build.
        if (Date.now() - lastProgressWrite < 2000 && added < total) return;
        lastProgressWrite = Date.now();
        Job.updateOne(
          { _id: job._id, status: "bundling" },
          { progress: { step: "bundling", filesProcessed: added, filesTotal: total, bytesUploaded: uploaded, bytesTotal: expectedBytes } }
        ).exec().catch(() => {});
      },
      shouldStop: async () => {
        if (isTimedOut()) return (timedOut = true);
        return isCancelled(jobId);
      },
    });

    // Complete only if still bundling: a cancel that landed at the last moment
    // wins, and the uploaded object is deleted rather than left billed (M1).
    const completed = await Job.updateOne(
      { _id: jobId, status: "bundling" },
      { status: "completed", r2Key: key, bundleSize: size, replayCount: files, progress: null, completedAt: new Date() }
    );
    if (completed.matchedCount === 0) {
      console.log(`Job ${jobId} no longer bundling (cancelled?) — deleting uploaded bundle`);
      await deleteFromStorage(key).catch(() => {});
      return true;
    }

    const elapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(
      `Job ${jobId} streamed to storage: ${files} files ` +
      `(${cacheHits} from slpz cache, ${files - cacheHits - rawFallbacks} fresh, ${rawFallbacks} as raw .slp), ` +
      `${(size / 1024 / 1024).toFixed(1)}MB in ${elapsed}s`
    );
  } catch (err) {
    const rawMsg = (err as Error).message;
    if (err instanceof BundleStopped) {
      if (!(await isCancelled(jobId))) {
        await Job.updateOne(
          { _id: jobId, status: "bundling" },
          { status: "failed", error: `Job timed out after ${Math.round(jobTimeoutMs / 60000)} minutes (during upload)`, progress: null }
        ).catch(() => {});
      } else {
        console.log(`Job ${jobId} cancelled during bundling — upload aborted`);
      }
      return true;
    }
    // A storage cap or a network blip isn't the job's fault: put it back in line
    // (and pause for a cap) instead of failing it. It restarts from scratch.
    const cap = classifyStorageError(err) === "cap";
    const transient = TRANSIENT.test(rawMsg) && (job.uploadAttempts ?? 0) + 1 < config.jobUploadMaxAttempts;
    if (cap || transient) {
      const requeued = await Job.updateOne(
        { _id: jobId, status: { $in: ["processing", "bundling"] } },
        { status: "pending", progress: null, startedAt: null, deadlineAt: null, ...(cap ? {} : { $inc: { uploadAttempts: 1 } }) }
      ).catch(() => null);
      if (requeued?.matchedCount) {
        if (cap) await pauseForStorageCap(`Upload of job ${jobId} refused: ${rawMsg}`);
        console.error(`Job ${jobId} ${cap ? "hit the storage cap" : "upload failed (will retry)"}:`, rawMsg);
        return true;
      }
    }
    const safeMsg = sanitizeJobErrorMessage(rawMsg);
    // Mark failed only if still in this worker's active states — never clobber a
    // cancel that already landed (M1).
    await Job.updateOne(
      { _id: jobId, status: { $in: ["processing", "bundling"] } },
      { status: "failed", error: safeMsg, progress: null }
    ).catch((saveErr) =>
      console.error(`Failed to save error state for job ${jobId}:`, (saveErr as Error).message)
    );

    console.error(`Job ${jobId} bundle failed:`, rawMsg);
  } finally {
    currentJobIds[lane] = null;
  }

  return true;
}

export function startCompressor(intervalMs = 5000): void {
  running = true;
  console.log("Compressor workers started (main + fast lanes)");

  for (const lane of LANES) {
    const tick = async () => {
      if (!running) return;
      try {
        const hadWork = await processNextCompression(lane);
        if (running) timers[lane] = setTimeout(tick, hadWork ? 500 : intervalMs);
      } catch (err) {
        console.error(`Compressor (${lane}) error:`, (err as Error).message);
        if (running) timers[lane] = setTimeout(tick, intervalMs);
      }
    };
    tick();
  }
}

export function stopCompressor(): void {
  running = false;
  for (const lane of LANES) {
    if (timers[lane]) clearTimeout(timers[lane]!);
    timers[lane] = null;
  }
  console.log("Compressor workers stopped");
}
