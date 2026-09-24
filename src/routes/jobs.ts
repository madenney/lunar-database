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

    // Global queue depth limit
    const pendingCount = await Job.countDocuments({ status: "pending" });
    if (pendingCount >= config.jobMaxPendingTotal) {
      sendApiError(res, 429, "queue_full");
      return;
    }

    const estimates = calculateEstimates(count, rawSize);

    // When a file/size cap is set, `count` is already capped. Get the uncapped
    // total so we can tell the user their bundle was trimmed — but only when a real
    // filter narrows it; for a limit-only job the uncapped total is the entire DB,
    // so skip that (potentially full-collection) count.
    let totalMatched = count;
    if (hasLimit && hasFilter) {
      const { query } = await resolveSelection(filter);
      totalMatched = await Replay.countDocuments(query).maxTimeMS(15000);
    }

    const job = await Job.create({
      filter,
      createdBy: clientId || null,
      replayCount: count,
      totalMatched,
      estimatedSize: rawSize,
      estimatedProcessingTime: estimates.estimatedProcessingTimeSec,
    });

    res.status(201).json({ jobId: job._id, status: job.status });
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

    const query = { createdBy: clientId };
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
        .select("filter replayCount bundleSize downloadCount completedAt lastDownloadedAt isFullDb")
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

// DELETE /api/jobs/:id — user cancels own job (must match createdBy, only pending/processing)
router.delete("/:id", jobDeleteLimiter, async (req: Request, res: Response) => {
  try {
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId) {
      sendApiError(res, 400, "invalid_client");
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

    // Ownership check — require matching clientId
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId || job.createdBy !== clientId) {
      sendApiError(res, 403, "forbidden");
      return;
    }

    let queuePosition: number | null = null;
    let estimatedWaitSec: number | null = null;
    let estimatedProcessingTimeSec: number | null = null;

    if (job.status === "pending") {
      // Count jobs ahead in queue (lower priority first, then earlier createdAt)
      const aheadCount = await Job.countDocuments({
        status: "pending",
        $or: [
          { priority: { $lt: job.priority } },
          { priority: job.priority, createdAt: { $lt: job.createdAt } },
        ],
      });

      // Sum estimated processing time of jobs ahead
      const aheadAgg = await Job.aggregate([
        {
          $match: {
            status: "pending",
            $or: [
              { priority: { $lt: job.priority } },
              { priority: job.priority, createdAt: { $lt: job.createdAt } },
            ],
          },
        },
        { $group: { _id: null, totalTime: { $sum: "$estimatedProcessingTime" } } },
      ]);

      queuePosition = aheadCount + 1;
      let waitSec = aheadAgg[0]?.totalTime ?? 0;

      // Check for a currently-active job and add its remaining time
      const activeJob = await Job.findOne({
        status: { $in: ["processing", "bundling", "uploading"] },
      }).select("estimatedProcessingTime progress").lean();

      if (activeJob) {
        const ept = activeJob.estimatedProcessingTime ?? 0;
        if (activeJob.progress && activeJob.progress.filesTotal > 0) {
          const fractionDone = activeJob.progress.filesProcessed / activeJob.progress.filesTotal;
          waitSec += Math.round(ept * (1 - fractionDone));
        } else {
          waitSec += ept;
        }
      }

      estimatedWaitSec = waitSec;
      estimatedProcessingTimeSec = job.estimatedProcessingTime;
    } else if (["processing", "bundling", "bundled", "uploading"].includes(job.status)) {
      queuePosition = 0;
      estimatedWaitSec = 0;
      const ept = job.estimatedProcessingTime ?? 0;
      if (job.progress && job.progress.filesTotal > 0) {
        const fractionDone = job.progress.filesProcessed / job.progress.filesTotal;
        estimatedProcessingTimeSec = Math.round(ept * (1 - fractionDone));
      } else {
        estimatedProcessingTimeSec = ept;
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

    // Ownership check — require matching clientId, EXCEPT for pinned bundles,
    // which are a public catalog ("Popular Downloads") any visitor may download.
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!job.pinned && (!clientId || job.createdBy !== clientId)) {
      sendApiError(res, 403, "forbidden");
      return;
    }

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
