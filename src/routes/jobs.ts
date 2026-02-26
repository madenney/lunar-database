import { Router, Request, Response } from "express";
import { Job, IJobFilter } from "../models/Job";
import { Replay } from "../models/Replay";
import { buildReplaySearchQuery } from "../services/replaySearchQuery";
import { getPresignedDownloadUrl } from "../services/r2";
import { sendError } from "../utils/sendError";
import { applyReplayLimits } from "../utils/applyReplayLimits";
import { config } from "../config";

const COMPRESS_RATE = 120; // files/sec

const router = Router();

function parseFilter(body: Record<string, any>): IJobFilter {
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
  if (body.maxFiles != null) filter.maxFiles = Number(body.maxFiles);
  if (body.maxSizeMb != null) filter.maxSizeMb = Number(body.maxSizeMb);
  return filter;
}

// POST /api/jobs — create a download job
router.post("/", async (req: Request, res: Response) => {
  try {
    const filter = parseFilter(req.body);

    const filterKeys = Object.keys(filter).filter((k) => k !== "maxFiles" && k !== "maxSizeMb");
    if (filterKeys.length === 0) {
      res.status(400).json({ error: "At least one filter field is required" });
      return;
    }

    const query = buildReplaySearchQuery(filter);
    const hasLimits = filter.maxFiles != null || filter.maxSizeMb != null;

    let count: number;
    let rawSize: number;

    if (hasLimits) {
      const docs = await Replay.find(query).select("fileSize").lean();
      const limited = applyReplayLimits(docs, filter.maxFiles, filter.maxSizeMb);
      count = limited.length;
      rawSize = limited.reduce((sum, r) => sum + (r.fileSize ?? 0), 0);
    } else {
      const [c, sizeAgg] = await Promise.all([
        Replay.countDocuments(query),
        Replay.aggregate([
          { $match: query },
          { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
        ]),
      ]);
      count = c;
      rawSize = sizeAgg[0]?.totalSize ?? 0;
    }

    if (count === 0) {
      res.status(400).json({ error: "No replays match this filter" });
      return;
    }

    const clientId = req.headers["x-client-id"] as string | undefined;

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
      res.status(503).json({
        error: `Job queue is full (${pendingCount} pending). Try again later.`,
      });
      return;
    }

    const estimatedTarSize = Math.round(rawSize / 8) + count * 1024;
    const compressTimeSec = count / COMPRESS_RATE;
    const uploadTimeSec = estimatedTarSize / (config.estimateUploadSpeedMbps * 125000);
    const estimatedProcessingTime = Math.round(compressTimeSec + uploadTimeSec);

    const job = await Job.create({
      filter,
      createdBy: clientId || null,
      replayCount: count,
      estimatedSize: rawSize,
      estimatedProcessingTime,
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
    const skip = (pageNum - 1) * limitNum;

    const query = { createdBy: clientId };
    const [jobs, total] = await Promise.all([
      Job.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select("status filter replayCount bundleSize r2Key progress error createdAt completedAt")
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
    const skip = (pageNum - 1) * limitNum;

    const query = { status: "completed", r2Key: { $ne: null } };
    const [bundles, total] = await Promise.all([
      Job.find(query)
        .sort({ downloadCount: -1, completedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select("filter replayCount bundleSize downloadCount completedAt")
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
      startedAt: job.startedAt,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/jobs/:id/download — generate fresh presigned URL and redirect
router.get("/:id/download", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status !== "completed" || !job.r2Key) {
      res.status(400).json({ error: "Download not ready" });
      return;
    }

    // Increment download counter
    Job.updateOne({ _id: job._id }, { $inc: { downloadCount: 1 } }).exec();

    // Generate a fresh 1-hour presigned URL on each request
    const url = await getPresignedDownloadUrl(job.r2Key, 3600);
    res.redirect(url);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
