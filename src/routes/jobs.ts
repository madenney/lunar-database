import { Router, Request, Response } from "express";
import { Job, IJobFilter } from "../models/Job";
import { getPublicDownloadUrl } from "../services/storage";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";
import { config } from "../config";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";

const router = Router();

export function parseFilter(body: Record<string, any>): IJobFilter {
  const filter: IJobFilter = {};
  if (body.p1ConnectCode) filter.p1ConnectCode = String(body.p1ConnectCode);
  if (body.p1CharacterId != null) filter.p1CharacterId = String(body.p1CharacterId);
  if (body.p1DisplayName) filter.p1DisplayName = String(body.p1DisplayName);
  if (body.p2ConnectCode) filter.p2ConnectCode = String(body.p2ConnectCode);
  if (body.p2CharacterId != null) filter.p2CharacterId = String(body.p2CharacterId);
  if (body.p2DisplayName) filter.p2DisplayName = String(body.p2DisplayName);
  if (body.stageId != null) filter.stageId = String(body.stageId);
  if (body.startDate) filter.startDate = String(body.startDate);
  if (body.endDate) filter.endDate = String(body.endDate);
  if (body.maxFiles != null) {
    const n = Number(body.maxFiles);
    if (Number.isFinite(n) && n >= 1) filter.maxFiles = Math.min(Math.floor(n), 50000);
  }
  if (body.maxSizeMb != null) {
    const n = Number(body.maxSizeMb);
    if (Number.isFinite(n) && n > 0) filter.maxSizeMb = Math.min(n, 10000);
  }
  return filter;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jobCreateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many job creation requests, please try again later" },
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

    const filterKeys = Object.keys(filter).filter((k) => k !== "maxFiles" && k !== "maxSizeMb");
    if (filterKeys.length === 0) {
      res.status(400).json({ error: "At least one filter field is required" });
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

    const job = await Job.create({
      filter,
      createdBy: clientId || null,
      replayCount: count,
      estimatedSize: rawSize,
      estimatedProcessingTime: estimates.estimatedProcessingTimeSec,
    });

    res.status(201).json({ jobId: job._id, status: job.status });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs — list jobs for a clientId (paginated)
router.get("/", async (req: Request, res: Response) => {
  try {
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (!clientId) {
      res.status(400).json({ error: "X-Client-Id header is required" });
      return;
    }

    const { page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
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

// GET /api/jobs/bundles — public catalog of completed bundles
router.get("/bundles", async (req: Request, res: Response) => {
  try {
    const { page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const skip = Math.min((pageNum - 1) * limitNum, 10000);

    const query = { status: "completed", r2Key: { $ne: null } };
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
router.delete("/:id", async (req: Request, res: Response) => {
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
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Ownership check — non-owners get limited info only
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (job.createdBy && job.createdBy !== clientId) {
      res.json({
        jobId: job._id,
        status: job.status,
        downloadReady: job.status === "completed" && !!job.r2Key,
      });
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

    res.json({
      jobId: job._id,
      status: job.status,
      replayCount: job.replayCount,
      estimatedSize: job.estimatedSize,
      bundleSize: job.bundleSize,
      downloadReady: job.status === "completed" && !!job.r2Key,
      downloadCount: job.downloadCount,
      progress: job.progress,
      error: job.error,
      queuePosition,
      estimatedWaitSec,
      estimatedProcessingTimeSec,
      lastDownloadedAt: job.lastDownloadedAt,
      startedAt: job.startedAt,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs/:id/download — return public download URL
router.get("/:id/download", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Ownership check — only the job creator can download
    const clientId = req.headers["x-client-id"] as string | undefined;
    if (job.createdBy && job.createdBy !== clientId) {
      res.status(403).json({ error: "Not authorized to download this job" });
      return;
    }

    if (job.status !== "completed" || !job.r2Key) {
      res.status(400).json({ error: "Download not ready" });
      return;
    }

    // Increment download counter and update last download timestamp
    Job.updateOne({ _id: job._id }, { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } }).exec().catch(() => {});

    const url = getPublicDownloadUrl(job.r2Key);
    res.json({ url });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
