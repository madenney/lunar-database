import { Router, Request, Response } from "express";
import { Job, ACTIVE_JOB_STATUSES } from "../models/Job";
import { sendApiError } from "../utils/apiErrors";
import { DownloadEvent } from "../models/DownloadEvent";
import { getPresignedDownloadUrl, headObject, classifyStorageError } from "../services/storage";
import { sendError } from "../utils/sendError";
import { createRateLimiter, cfKeyGenerator } from "../utils/rateLimiter";
import { checkFullDbDownloadLimit, recordAnonymousFullDbDownload, formatRetryAfter } from "../services/fullDbLimiter";
import { config } from "../config";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";
import { resolveSelection } from "../services/replaySearchQuery";
import { parseFilter, hasFilterOrLimit } from "../services/replayFilter";
import { Replay } from "../models/Replay";
import { SAFE_JOB_ERROR_MESSAGES } from "../utils/sanitizeError";
import {
  filterKey, findReusableJob, bundleBytes, laneFor, queueSnapshot, forecastNewJob,
  getQueueState, pauseMessage,
} from "../services/jobQueue";

const router = Router();

/**
 * Errors safe to show to API consumers as-is. These are the already-sanitized
 * messages the worker stores (see SAFE_JOB_ERROR_MESSAGES), plus any errors
 * raised directly by this route. Keeping the worker's list as the source of
 * truth means new failure reasons surface to users automatically.
 */
const USER_FACING_ERRORS = [...SAFE_JOB_ERROR_MESSAGES];

/** Return a generic message for internal errors, pass through user-facing ones */
function sanitizeJobError(error: string): string {
  if (USER_FACING_ERRORS.some((msg) => error.startsWith(msg))) return error;
  return "Server error — please try again later";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bundlesLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests, please try again later" },
});

const jobCreateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many job creation requests, please try again later" },
});

const jobListLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests, please try again later" },
});

const jobStatusLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

const jobDeleteLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many delete requests, please try again later" },
});

const jobDownloadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many download requests, please try again later" },
});

// POST /api/jobs — create a download job
router.post("/", jobCreateLimiter, async (req: Request, res: Response) => {
  try {
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId || !UUID_RE.test(clientId)) {
      sendApiError(res, 400, "invalid_client");
      return;
    }

    const filter = parseFilter(req.body);

    const { hasFilter, hasLimit } = hasFilterOrLimit(filter);
    if (!hasFilter && !hasLimit) {
      sendApiError(res, 400, "filter_required");
      return;
    }

    // Someone already asked for exactly this: share their job (or its finished
    // bundle) instead of building the same thing again.
    const key = filterKey(filter as Record<string, unknown>);
    const existing = await findReusableJob(key);
    if (existing) {
      if (existing.createdBy !== clientId) {
        await Job.updateOne({ _id: existing._id }, { $addToSet: { followers: clientId } });
      }
      res.status(200).json({ jobId: existing._id, status: existing.status, reused: true });
      return;
    }

    const { count, rawSize } = await queryCountAndSize(filter);

    if (count === 0) {
      sendApiError(res, 400, "no_matches");
      return;
    }

    // Per-client concurrent job limit (non-terminal jobs)
    if (clientId) {
      const activeCount = await Job.countDocuments({
        createdBy: clientId,
        status: { $in: ACTIVE_JOB_STATUSES },
      });
      if (activeCount >= config.jobMaxConcurrentPerClient) {
        sendApiError(res, 429, "too_many_active_jobs", {
          error: `You already have ${activeCount} active job(s). Maximum is ${config.jobMaxConcurrentPerClient}. Wait for one to finish or cancel it.`,
          limit: config.jobMaxConcurrentPerClient,
        });
        return;
      }
    }

    const estimates = calculateEstimates(count, rawSize);

    // One bundle may not be bigger than jobMaxBundleMb: past that, the full-DB
    // download (or a narrower filter) is the right tool.
    const maxBytes = config.jobMaxBundleMb * 1024 * 1024;
    if (maxBytes > 0 && estimates.estimatedZipSize > maxBytes) {
      sendApiError(res, 400, "too_large", { estimatedBytes: estimates.estimatedZipSize, maxBytes });
      return;
    }

    // Global queue depth limit
    const pendingCount = await Job.countDocuments({ status: "pending" });
    if (pendingCount >= config.jobMaxPendingTotal) {
      const snap = await queueSnapshot();
      let workSec = 0;
      for (const f of snap.forecast.values()) workSec = Math.max(workSec, f.readySec);
      sendApiError(res, 429, "queue_full", { pending: pendingCount, workSec });
      return;
    }

    // When a file/size cap is set, `count` is already capped. Get the uncapped
    // total so we can tell the user their bundle was trimmed — but only when a real
    // filter narrows it; for a limit-only job the uncapped total is the entire DB,
    // so skip that (potentially full-collection) count.
    let totalMatched = count;
    if (hasLimit && hasFilter) {
      const { query, hint } = await resolveSelection(filter);
      totalMatched = await Replay.countDocuments(query, hint ? { hint } : {}).maxTimeMS(15000);
    }

    const job = await Job.create({
      filter,
      filterKey: key || null,
      lane: laneFor(estimates.estimatedZipSize),
      createdBy: clientId || null,
      replayCount: count,
      totalMatched,
      estimatedSize: rawSize,
      estimatedProcessingTime: estimates.estimatedProcessingTimeSec,
    });

    res.status(201).json({ jobId: job._id, status: job.status, reused: false, lane: job.lane });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs — list jobs for a clientId (paginated)
router.get("/", jobListLimiter, async (req: Request, res: Response) => {
  try {
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId) {
      sendApiError(res, 400, "invalid_client");
      return;
    }

    const { page = "1", limit = "20" } = req.query;
    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    const limitNum = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    const skip = Math.min((pageNum - 1) * limitNum, 10000);

    const query = { $or: [{ createdBy: clientId }, { followers: clientId }] };
    const [jobs, total] = await Promise.all([
      Job.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select("status filter replayCount bundleSize r2Key progress error createdAt completedAt lastDownloadedAt")
        .lean(),
      Job.countDocuments(query),
    ]);

    const mapped = jobs.map((j) => ({
      ...j,
      downloadReady: j.status === "completed" && !!j.r2Key,
    }));

    res.json({
      jobs: mapped,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs/bundles — public catalog of pinned (permanent) bundles.
// Only pinned bundles are listed: unpinned bundles are ephemeral (~3 day expiry)
// and pinned bundles are the ones any visitor is allowed to download.
router.get("/bundles", bundlesLimiter, async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20" } = req.query;
    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    const limitNum = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
    const skip = Math.min((pageNum - 1) * limitNum, 10000);

    const query = { status: "completed", r2Key: { $ne: null }, pinned: true };
    const [bundles, total] = await Promise.all([
      Job.find(query)
        // Surface the full-DB bundle first regardless of download count, so the
        // frontend reliably finds it on page 1 (it's also flagged with fullDb).
        .sort({ isFullDb: -1, downloadCount: -1, completedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select("filter replayCount bundleSize downloadCount completedAt lastDownloadedAt isFullDb snapshotAt")
        .lean(),
      Job.countDocuments(query),
    ]);

    const shaped = bundles.map(({ isFullDb, ...b }) => ({ ...b, fullDb: !!isFullDb }));

    res.json({
      bundles: shaped,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    sendError(res, err);
  }
});

const queueLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

let recentCache: { at: number; jobs: any[] } | null = null;

/** Finished bundles still in storage, newest first (cached briefly). */
async function recentBundles() {
  if (process.env.NODE_ENV !== "test" && recentCache && Date.now() - recentCache.at < 15_000) return recentCache.jobs;
  const cutoff = new Date(Date.now() - config.storageCleanupAfterDays * 86400 * 1000);
  const jobs = await Job.find({
    status: "completed",
    r2Key: { $ne: null },
    isFullDb: { $ne: true },
    $or: [{ pinned: true }, { lastDownloadedAt: { $gte: cutoff } }, { lastDownloadedAt: null, completedAt: { $gte: cutoff } }],
  })
    .sort({ completedAt: -1 })
    .limit(60)
    .select("filter replayCount bundleSize completedAt lastDownloadedAt downloadCount pinned createdBy followers")
    .lean();
  recentCache = { at: Date.now(), jobs };
  return jobs;
}

// GET /api/jobs/queue — the public download queue: what's being built, what's
// waiting (with forecasts), and recent bundles anyone can download right now.
// Never exposes who asked for what; `mine` only marks the caller's own jobs.
router.get("/queue", queueLimiter, async (req: Request, res: Response) => {
  try {
    const clientId = req.headers["x-client-id"] as string | undefined;
    const mine = (j: any) => !!clientId && (j.createdBy === clientId || (j.followers ?? []).includes(clientId));
    const [snap, state, recent] = await Promise.all([queueSnapshot(), getQueueState(), recentBundles()]);
    let workSec = 0;
    for (const f of snap.forecast.values()) workSec = Math.max(workSec, f.readySec);
    const shared = (j: any) => (j.followers ?? []).length + 1;
    const pct = (j: any) => {
      const p = j.progress;
      if (!p) return j.status === "bundled" ? 50 : 0;
      if (p.step === "uploading" && p.bytesTotal) return Math.round(50 + 50 * ((p.bytesUploaded ?? 0) / p.bytesTotal));
      if (p.step === "bundling" && p.bytesUploaded != null && p.filesTotal) return Math.round(100 * (p.filesProcessed / p.filesTotal));
      return p.filesTotal ? Math.round(50 * (p.filesProcessed / p.filesTotal)) : 0;
    };
    const cleanupMs = config.storageCleanupAfterDays * 86400 * 1000;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      paused: pauseMessage(state),
      throughputBps: Math.round(snap.bps),
      workSec,
      running: snap.running.map((j) => ({
        id: j._id, filter: j.filter, replayCount: j.replayCount, bytes: bundleBytes(j), status: j.status, lane: j.lane,
        progressPct: pct(j), readySec: snap.forecast.get(String(j._id))?.readySec ?? null, shared: shared(j), mine: mine(j),
      })),
      waiting: snap.pending.slice(0, 300).map((j, i) => {
        const f = snap.forecast.get(String(j._id));
        return {
          id: j._id, filter: j.filter, replayCount: j.replayCount, bytes: bundleBytes(j), lane: j.lane, position: i + 1,
          startSec: f?.startSec ?? null, readySec: f?.readySec ?? null, shared: shared(j), mine: mine(j),
        };
      }),
      waitingTotal: snap.pending.length,
      recent: recent.map((j) => ({
        id: j._id, filter: j.filter, replayCount: j.replayCount, bundleSize: j.bundleSize, completedAt: j.completedAt,
        downloadCount: j.downloadCount, pinned: !!j.pinned, mine: mine(j),
        expiresAt: j.pinned ? null : new Date(((j.lastDownloadedAt ?? j.completedAt) as Date).getTime() + cleanupMs),
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// DELETE /api/jobs/:id — user cancels own job (must match createdBy, only pending/processing)
router.delete("/:id", jobDeleteLimiter, async (req: Request, res: Response) => {
  try {
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId) {
      sendApiError(res, 400, "invalid_client");
      return;
    }

    // A follower leaving a shared job just stops following it.
    const left = await Job.updateOne({ _id: req.params.id, followers: clientId }, { $pull: { followers: clientId } });
    if (left.modifiedCount) {
      res.json({ message: "Job cancelled" });
      return;
    }

    // The creator of a shared job hands it to the next follower instead of
    // cancelling it for everyone.
    const handed = await Job.findOneAndUpdate(
      { _id: req.params.id, createdBy: clientId, status: { $in: ACTIVE_JOB_STATUSES }, "followers.0": { $exists: true } },
      [{ $set: { createdBy: { $first: "$followers" }, followers: { $slice: ["$followers", 1, 100000] } } }],
      { updatePipeline: true },
    );
    if (handed) {
      res.json({ message: "Job cancelled" });
      return;
    }

    // One conditional update, so a worker finishing the job at the same moment
    // can't be overwritten (which would orphan its uploaded bundle).
    const cancelled = await Job.findOneAndUpdate(
      { _id: req.params.id, createdBy: clientId, status: { $in: ACTIVE_JOB_STATUSES } },
      { $set: { status: "cancelled", progress: null } },
    );
    if (cancelled) {
      res.json({ message: "Job cancelled" });
      return;
    }

    const job = await Job.findById(req.params.id).select("createdBy status").lean();
    if (!job) {
      sendApiError(res, 404, "not_found");
    } else if (job.createdBy !== clientId) {
      sendApiError(res, 403, "forbidden");
    } else {
      sendApiError(res, 400, "cannot_cancel", { error: `Cannot cancel a ${job.status} job`, status: job.status });
    }
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs/:id — check job status
router.get("/:id", jobStatusLimiter, async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      sendApiError(res, 404, "not_found");
      return;
    }

    // Ownership check — the creator or anyone sharing the job
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId || (job.createdBy !== clientId && !(job.followers ?? []).includes(clientId))) {
      sendApiError(res, 403, "forbidden");
      return;
    }

    let queuePosition: number | null = null;
    let estimatedWaitSec: number | null = null;
    let estimatedProcessingTimeSec: number | null = null;

    if (job.status === "pending" || ["processing", "bundling", "bundled", "uploading"].includes(job.status)) {
      // Forecast from a simulation of both worker lanes at the measured rate.
      const f = (await queueSnapshot()).forecast.get(String(job._id));
      if (job.status === "pending") {
        queuePosition = (f?.ahead ?? 0) + 1;
        estimatedWaitSec = f?.startSec ?? null;
        estimatedProcessingTimeSec = f ? Math.max(0, f.readySec - f.startSec) : job.estimatedProcessingTime;
      } else {
        queuePosition = 0;
        estimatedWaitSec = 0;
        estimatedProcessingTimeSec = f?.readySec ?? job.estimatedProcessingTime;
      }
    }
    // Terminal statuses: all remain null

    // When the bundle will be auto-removed: retention runs from the last
    // download (or completion if never downloaded). Pinned bundles never expire.
    let expiresAt: Date | null = null;
    if (job.status === "completed" && job.r2Key && !job.pinned) {
      const basis = job.lastDownloadedAt ?? job.completedAt;
      if (basis) {
        expiresAt = new Date(basis.getTime() + config.storageCleanupAfterDays * 24 * 60 * 60 * 1000);
      }
    }

    res.json({
      jobId: job._id,
      status: job.status,
      replayCount: job.replayCount,
      totalMatched: job.totalMatched,
      capped: job.totalMatched != null && job.totalMatched > job.replayCount,
      estimatedSize: job.estimatedSize,
      bundleSize: job.bundleSize,
      downloadReady: job.status === "completed" && !!job.r2Key,
      pinned: job.pinned,
      downloadCount: job.downloadCount,
      progress: job.progress,
      error: job.error ? sanitizeJobError(job.error) : null,
      queuePosition,
      estimatedWaitSec,
      estimatedProcessingTimeSec,
      lane: job.lane,
      /** How many other people are waiting on this same bundle. */
      sharedWith: (job.followers ?? []).filter((f) => f !== clientId).length + (job.createdBy && job.createdBy !== clientId ? 1 : 0),
      paused: pauseMessage(await getQueueState()),
      lastDownloadedAt: job.lastDownloadedAt,
      startedAt: job.startedAt,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      expiresAt,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs/:id/download — return presigned download URL
router.get("/:id/download", jobDownloadLimiter, async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      sendApiError(res, 404, "not_found");
      return;
    }

    // Any finished bundle is downloadable by anyone: the queue page lists recent
    // bundles so people can grab one instead of queueing the same thing again.
    const clientId = req.headers["x-client-id"] as string | undefined;

    if (job.status !== "completed" || !job.r2Key) {
      sendApiError(res, 400, "not_ready");
      return;
    }

    // Full-DB throttle: cap how many ~1.3 TB pulls one caller can trigger per
    // window (see fullDbLimiter). Checked before the B2 HEAD so a rate-limited
    // caller costs us nothing. Only full-DB bundles are affected.
    if (job.isFullDb) {
      const limit = await checkFullDbDownloadLimit(clientId, cfKeyGenerator(req));
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        sendApiError(res, 429, "fulldb_rate_limited", {
          error: `The full database can be downloaded ${config.fullDbMaxPerWindow}× per ${config.fullDbWindowHours}h. Please try again in ${formatRetryAfter(limit.retryAfterSeconds)}.`,
          retryAfterSeconds: limit.retryAfterSeconds,
        });
        return;
      }
    }

    // Best-effort pre-check: a HEAD lets us report a definite storage problem
    // instead of handing out a URL that fails mid-download. It FAILS OPEN: any
    // unclassified probe error (network blip, no creds in tests) still presigns.
    // (B2 enforces the cap on the actual byte transfer, so a full-DB pull counts
    // against egress like any other download.)
    try {
      await headObject(job.r2Key);
    } catch (probeErr) {
      const kind = classifyStorageError(probeErr);
      if (kind === "cap") {
        sendApiError(res, 503, "download_cap");
        return;
      }
      if (kind === "busy") {
        sendApiError(res, 503, "storage_busy");
        return;
      }
      if (kind === "notfound") {
        sendApiError(res, 410, "bundle_missing");
        return;
      }
    }

    // Increment download counter and update last download timestamp
    Job.updateOne({ _id: job._id }, { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } }).exec().catch(() => {});

    // Log download event for analytics (full-DB pulls tagged distinctly). This
    // DownloadEvent is also what the full-DB throttle counts for identified
    // clients; anonymous pulls are counted in-memory, so record those here too.
    DownloadEvent.create({
      type: job.isFullDb ? "full_db" : "job",
      jobId: job._id,
      clientId: clientId || null,
      bundleSize: job.bundleSize,
      replayCount: job.replayCount,
    }).catch(() => {});
    if (job.isFullDb && !clientId) recordAnonymousFullDbDownload(cfKeyGenerator(req));

    // `filename` is a cosmetic, caller-supplied name for the saved file; it's
    // sanitized + forced to `.zip` inside getPresignedDownloadUrl. Passing it
    // sets Content-Disposition on the presigned URL so the browser doesn't fall
    // back to naming the file after the storage key (which is how old `.tar`
    // objects saved as `.tar`). Falls back to the job id when absent.
    const requestedName =
      typeof req.query.filename === "string" && req.query.filename.trim()
        ? req.query.filename
        : `lunar-db-${String(job._id).slice(-8)}`;
    const url = await getPresignedDownloadUrl(job.r2Key, 3600, requestedName);
    res.json({ url });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
