import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { config } from "../config";
import { Admin } from "../models/Admin";
import { Job, JobStatus } from "../models/Job";
import { Replay } from "../models/Replay";
import { requireAdmin } from "../middleware/auth";
import { sendError } from "../utils/sendError";
import { startCompressor, stopCompressor, isCompressorRunning, getCompressorJobId } from "../workers/compressWorker";
import { startUploader, stopUploader, isUploaderRunning, getUploaderJobId } from "../workers/uploadWorker";
import { deleteFromR2 } from "../services/r2";
import { cleanupJobTemp, getTempDiskUsage, cleanupOrphanedTemp } from "../services/bundler";
import { buildReplaySearchQuery } from "../services/replaySearchQuery";
import { applyReplayLimits } from "../utils/applyReplayLimits";

const COMPRESS_RATE = 120; // files/sec

const VALID_JOB_STATUSES: JobStatus[] = [
  "pending", "processing", "compressing", "compressed", "uploading", "completed", "failed", "cancelled",
];

const router = Router();

// POST /api/admin/login — public, returns JWT
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const admin = await Admin.findOne({ username });
    if (!admin || !(await admin.comparePassword(password))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = jwt.sign(
      { adminId: admin._id.toString(), username: admin.username },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn as any }
    );

    res.json({ token, username: admin.username });
  } catch (err) {
    sendError(res, err);
  }
});

// All routes below require admin auth
router.use(requireAdmin);

// GET /api/admin/status — system health, worker state, DB stats, disk usage
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const [replayCount, jobCounts, dbStats, tempDisk] = await Promise.all([
      Replay.countDocuments(),
      Job.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      mongoose.connection.db!.stats(),
      getTempDiskUsage(),
    ]);

    const jobs: Record<string, number> = {};
    for (const entry of jobCounts) {
      jobs[entry._id] = entry.count;
    }

    res.json({
      compressor: {
        running: isCompressorRunning(),
        currentJobId: getCompressorJobId(),
      },
      uploader: {
        running: isUploaderRunning(),
        currentJobId: getUploaderJobId(),
      },
      replays: replayCount,
      jobs,
      tempDisk: {
        usedBytes: tempDisk.usedBytes,
        usedMb: Math.round(tempDisk.usedBytes / (1024 * 1024)),
        freeBytes: tempDisk.freeBytes,
        freeMb: Math.round(tempDisk.freeBytes / (1024 * 1024)),
        entries: tempDisk.entries,
      },
      limits: {
        jobMaxConcurrentPerClient: config.jobMaxConcurrentPerClient,
        jobMaxPendingTotal: config.jobMaxPendingTotal,
        jobTimeoutMinutes: config.jobTimeoutMinutes,
        slpzTimeoutMinutes: config.slpzTimeoutMinutes,
        minFreeDiskMb: config.minFreeDiskMb,
      },
      dbSizeBytes: dbStats.dataSize,
      uptime: process.uptime(),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/admin/worker/compressor/start
router.post("/worker/compressor/start", (_req: Request, res: Response) => {
  if (isCompressorRunning()) {
    res.json({ message: "Compressor already running" });
    return;
  }
  startCompressor();
  res.json({ message: "Compressor started" });
});

// POST /api/admin/worker/compressor/stop
router.post("/worker/compressor/stop", (_req: Request, res: Response) => {
  if (!isCompressorRunning()) {
    res.json({ message: "Compressor already stopped" });
    return;
  }
  stopCompressor();
  res.json({ message: "Compressor stopped" });
});

// POST /api/admin/worker/uploader/start
router.post("/worker/uploader/start", (_req: Request, res: Response) => {
  if (isUploaderRunning()) {
    res.json({ message: "Uploader already running" });
    return;
  }
  startUploader();
  res.json({ message: "Uploader started" });
});

// POST /api/admin/worker/uploader/stop
router.post("/worker/uploader/stop", (_req: Request, res: Response) => {
  if (!isUploaderRunning()) {
    res.json({ message: "Uploader already stopped" });
    return;
  }
  stopUploader();
  res.json({ message: "Uploader stopped" });
});

// GET /api/admin/worker/status
router.get("/worker/status", (_req: Request, res: Response) => {
  res.json({
    compressor: {
      running: isCompressorRunning(),
      currentJobId: getCompressorJobId(),
    },
    uploader: {
      running: isUploaderRunning(),
      currentJobId: getUploaderJobId(),
    },
  });
});

// GET /api/admin/jobs — list all jobs with optional filters
router.get("/jobs", async (req: Request, res: Response) => {
  try {
    const { status, createdBy, startDate, endDate, page = "1", limit = "50" } = req.query;
    const query: Record<string, any> = {};

    if (status) query.status = String(status);
    if (createdBy) query.createdBy = String(createdBy);
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate as string);
      if (endDate) query.createdAt.$lte = new Date(endDate as string);
    }

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const sort = query.status === "pending"
      ? { priority: 1, createdAt: 1 }
      : { createdAt: -1 };

    const [jobs, total] = await Promise.all([
      Job.find(query).sort(sort as any).skip(skip).limit(limitNum).lean(),
      Job.countDocuments(query),
    ]);

    res.json({
      jobs,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/jobs/queue — view current queue
router.get("/jobs/queue", async (_req: Request, res: Response) => {
  try {
    const [activeJob, queue] = await Promise.all([
      Job.findOne({ status: { $in: ["processing", "compressing", "uploading"] } }).lean(),
      Job.find({ status: "pending" }).sort({ priority: 1, createdAt: 1 }).lean(),
    ]);

    res.json({ activeJob: activeJob || null, queue });
  } catch (err) {
    sendError(res, err);
  }
});

// PUT /api/admin/jobs/reorder — bulk reorder pending jobs
router.put("/jobs/reorder", async (req: Request, res: Response) => {
  try {
    const { jobIds } = req.body;
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      res.status(400).json({ error: "jobIds must be a non-empty array" });
      return;
    }

    // Verify all jobs exist and are pending
    const jobs = await Job.find({ _id: { $in: jobIds } }).select("status").lean();
    if (jobs.length !== jobIds.length) {
      res.status(400).json({ error: "One or more job IDs not found" });
      return;
    }

    const nonPending = jobs.find((j) => j.status !== "pending");
    if (nonPending) {
      res.status(400).json({ error: "All jobs must be pending to reorder" });
      return;
    }

    const ops = jobIds.map((id: string, i: number) => ({
      updateOne: {
        filter: { _id: id },
        update: { priority: i },
      },
    }));

    await Job.bulkWrite(ops);
    res.json({ message: `Reordered ${jobIds.length} jobs` });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/jobs/:id — full job document
router.get("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(job);
  } catch (err) {
    sendError(res, err);
  }
});

// PATCH /api/admin/jobs/:id — edit filter (if pending), change status
router.patch("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const { filter, status, priority } = req.body;

    if (filter) {
      if (job.status !== "pending") {
        res.status(400).json({ error: "Can only edit filter on pending jobs" });
        return;
      }
      job.filter = filter;
    }

    if (priority != null) {
      if (job.status !== "pending") {
        res.status(400).json({ error: "Can only change priority on pending jobs" });
        return;
      }
      if (!Number.isInteger(priority)) {
        res.status(400).json({ error: "Priority must be an integer" });
        return;
      }
      job.priority = priority;
    }

    if (status) {
      if (!VALID_JOB_STATUSES.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_JOB_STATUSES.join(", ")}` });
        return;
      }
      job.status = status;
    }

    await job.save();
    res.json(job);
  } catch (err) {
    sendError(res, err);
  }
});

// DELETE /api/admin/jobs/:id — cancel + clean up R2 object + temp files
router.delete("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Clean up R2 object if it exists
    if (job.r2Key) {
      try {
        await deleteFromR2(job.r2Key);
      } catch (err) {
        console.error(`Failed to delete R2 key ${job.r2Key}:`, (err as Error).message);
      }
    }

    // Clean up local temp files
    cleanupJobTemp(job._id.toString());

    job.status = "cancelled";
    job.progress = null;
    await job.save();

    res.json({ message: "Job cancelled and cleaned up" });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/admin/jobs/:id/retry — reset failed/cancelled job to pending
router.post("/jobs/:id/retry", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status !== "failed" && job.status !== "cancelled") {
      res.status(400).json({ error: "Can only retry failed or cancelled jobs" });
      return;
    }

    // Re-estimate count and size
    const query = buildReplaySearchQuery(job.filter);
    const hasLimits = job.filter.maxFiles != null || job.filter.maxSizeMb != null;

    let count: number;
    let rawSize: number;

    if (hasLimits) {
      const docs = await Replay.find(query).select("fileSize").lean();
      const limited = applyReplayLimits(docs, job.filter.maxFiles, job.filter.maxSizeMb);
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

    const estimatedTarSize = Math.round(rawSize / 8) + count * 1024;
    const compressTimeSec = count / COMPRESS_RATE;
    const uploadTimeSec = estimatedTarSize / (config.estimateUploadSpeedMbps * 125000);

    job.status = "pending";
    job.error = null;
    job.progress = null;
    job.r2Key = null;
    job.bundleSize = null;
    job.bundlePath = null;
    job.startedAt = null;
    job.replayIds = [];
    job.replayCount = count;
    job.estimatedSize = rawSize;
    job.estimatedProcessingTime = Math.round(compressTimeSec + uploadTimeSec);
    job.completedAt = null;
    await job.save();

    res.json({ jobId: job._id, status: job.status });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/admin/temp/cleanup — clean orphaned temp files
router.post("/temp/cleanup", async (req: Request, res: Response) => {
  try {
    const maxAgeHours = req.body.maxAgeHours ?? 24;
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const cleaned = await cleanupOrphanedTemp(maxAgeMs);
    const disk = await getTempDiskUsage();
    res.json({
      cleaned,
      remaining: disk.entries,
      usedMb: Math.round(disk.usedBytes / (1024 * 1024)),
      freeMb: Math.round(disk.freeBytes / (1024 * 1024)),
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
