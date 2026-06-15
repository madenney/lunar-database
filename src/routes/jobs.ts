import { Router, Request, Response } from "express";
import { Job, IJobFilter } from "../models/Job";
import { DownloadEvent } from "../models/DownloadEvent";
import { getPresignedDownloadUrl } from "../services/storage";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";
import { config } from "../config";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";
import { buildReplaySearchQuery } from "../services/replaySearchQuery";
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

const MAX_FILTER_STRING_LEN = 100;

function safeString(val: unknown, maxLen = MAX_FILTER_STRING_LEN): string | undefined {
  if (val == null) return undefined;
  if (typeof val !== "string" && typeof val !== "number") return undefined;
  return String(val).slice(0, maxLen);
}

export function parseFilter(body: Record<string, any>): IJobFilter {
  const filter: IJobFilter = {};
  const p1cc = safeString(body.p1ConnectCode); if (p1cc) filter.p1ConnectCode = p1cc;
  const p1ci = safeString(body.p1CharacterId); if (p1ci) filter.p1CharacterId = p1ci;
  const p1dn = safeString(body.p1DisplayName); if (p1dn) filter.p1DisplayName = p1dn;
  const p2cc = safeString(body.p2ConnectCode); if (p2cc) filter.p2ConnectCode = p2cc;
  const p2ci = safeString(body.p2CharacterId); if (p2ci) filter.p2CharacterId = p2ci;
  const p2dn = safeString(body.p2DisplayName); if (p2dn) filter.p2DisplayName = p2dn;
  const sid = safeString(body.stageId); if (sid) filter.stageId = sid;
  const sd = safeString(body.startDate); if (sd) filter.startDate = sd;
  const ed = safeString(body.endDate); if (ed) filter.endDate = ed;
  if (body.maxFiles != null) {
    const n = Number(body.maxFiles);
    if (Number.isFinite(n) && n >= 1) filter.maxFiles = Math.min(Math.floor(n), 50000);
  }
  if (body.maxSizeMb != null) {
    const n = Number(body.maxSizeMb);
    if (Number.isFinite(n) && n > 0) filter.maxSizeMb = Math.min(n, 10000);
  }
  const srt = safeString(body.sort); if (srt) filter.sort = srt;
  return filter;
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
      res.status(400).json({ error: "Valid X-Client-Id header (UUID) is required" });
      return;
    }

    const filter = parseFilter(req.body);

    const filterKeys = Object.keys(filter).filter((k) => k !== "maxFiles" && k !== "maxSizeMb" && k !== "sort");
    const hasLimit = filter.maxFiles != null || filter.maxSizeMb != null;
    if (filterKeys.length === 0 && !hasLimit) {
      res.status(400).json({ error: "Add at least one filter or a limit" });
      return;
    }

    const { count, rawSize } = await queryCountAndSize(filter);

    if (count === 0) {
      res.status(400).json({ error: "No replays match this filter" });
      return;
    }

    // Per-client concurrent job limit (non-terminal jobs)
    if (clientId) {
      const activeCount = await Job.countDocuments({
        createdBy: clientId,
        status: { $in: ["pending", "processing", "compressing", "compressed", "uploading"] },
      });
      if (activeCount >= config.jobMaxConcurrentPerClient) {
        res.status(429).json({
          error: `You already have ${activeCount} active job(s). Maximum is ${config.jobMaxConcurrentPerClient}. Wait for one to finish or cancel it.`,
        });
        return;
      }
    }

    // Global queue depth limit
    const pendingCount = await Job.countDocuments({ status: "pending" });
    if (pendingCount >= config.jobMaxPendingTotal) {
      res.status(429).json({
        error: `Job queue is full (${pendingCount} pending). Try again later.`,
      });
      return;
    }

    const estimates = calculateEstimates(count, rawSize);

    // When a file/size cap is set, `count` is already capped. Get the uncapped
    // total so we can tell the user their bundle was trimmed — but only when a real
    // filter narrows it; for a limit-only job the uncapped total is the entire DB,
    // so skip that (potentially full-collection) count.
    let totalMatched = count;
    if (hasLimit && filterKeys.length > 0) {
      totalMatched = await Replay.countDocuments(buildReplaySearchQuery(filter)).maxTimeMS(15000);
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
      res.status(400).json({ error: "X-Client-Id header is required" });
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
        .sort({ downloadCount: -1, completedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select("filter replayCount bundleSize downloadCount completedAt lastDownloadedAt")
        .lean(),
      Job.countDocuments(query),
    ]);

    res.json({
      bundles,
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
      res.status(400).json({ error: "X-Client-Id header is required" });
      return;
    }

    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.createdBy !== clientId) {
      res.status(403).json({ error: "Not your job" });
      return;
    }

    if (job.status !== "pending" && job.status !== "processing" && job.status !== "compressing" && job.status !== "compressed" && job.status !== "uploading") {
      res.status(400).json({ error: `Cannot cancel a ${job.status} job` });
      return;
    }

    job.status = "cancelled";
    job.progress = null;
    await job.save();

    res.json({ message: "Job cancelled" });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs/:id — check job status
router.get("/:id", jobStatusLimiter, async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Ownership check — require matching clientId
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId || job.createdBy !== clientId) {
      res.status(403).json({ error: "Not authorized to view this job" });
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
        status: { $in: ["processing", "compressing", "uploading"] },
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
    } else if (["processing", "compressing", "compressed", "uploading"].includes(job.status)) {
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
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Ownership check — require matching clientId, EXCEPT for pinned bundles,
    // which are a public catalog ("Popular Downloads") any visitor may download.
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!job.pinned && (!clientId || job.createdBy !== clientId)) {
      res.status(403).json({ error: "Not authorized to download this job" });
      return;
    }

    if (job.status !== "completed" || !job.r2Key) {
      res.status(400).json({ error: "Download not ready" });
      return;
    }

    // Increment download counter and update last download timestamp
    Job.updateOne({ _id: job._id }, { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } }).exec().catch(() => {});

    // Log download event for analytics
    DownloadEvent.create({
      type: "job",
      jobId: job._id,
      clientId: clientId || null,
      bundleSize: job.bundleSize,
      replayCount: job.replayCount,
    }).catch(() => {});

    const url = await getPresignedDownloadUrl(job.r2Key);
    res.json({ url });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
