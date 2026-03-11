import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { config } from "../config";
import { Admin } from "../models/Admin";
import { Job, JobStatus } from "../models/Job";
import { Replay } from "../models/Replay";
import { requireAdmin } from "../middleware/auth";
import { sendError } from "../utils/sendError";
import { startCompressor, stopCompressor, isCompressorRunning, getCompressorJobId } from "../workers/compressWorker";
import { startUploader, stopUploader, isUploaderRunning, getUploaderJobId } from "../workers/uploadWorker";
import { startCleanupWorker, stopCleanupWorker, isCleanupRunning } from "../workers/cleanupWorker";
import { cleanupExpiredJobs } from "../services/storageCleanup";
import { deleteFromStorage } from "../services/storage";
import { cleanupJobTemp, getTempDiskUsage, cleanupOrphanedTemp } from "../services/bundler";
import { parseFilter } from "./jobs";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";

// Pre-computed dummy hash for timing-safe login comparison
const DUMMY_HASH = bcrypt.hashSync("dummy-timing-safe-value", 12);

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
    if (!admin) {
      // Run bcrypt.compare against dummy hash so response time is constant
      await bcrypt.compare(password, DUMMY_HASH);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (!(await admin.comparePassword(password))) {
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

// Audit logging for admin mutations
router.use((req: Request, _res: Response, next) => {
  if (req.method !== "GET") {
    console.log(`[ADMIN] ${req.admin?.username} ${req.method} ${req.path}`);
  }
  next();
});

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
      cleanup: {
        running: isCleanupRunning(),
        maxAgeDays: config.storageCleanupAfterDays,
        intervalMinutes: config.storageCleanupIntervalMinutes,
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

// POST /api/admin/worker/cleanup/start
router.post("/worker/cleanup/start", (_req: Request, res: Response) => {
  if (isCleanupRunning()) {
    res.json({ message: "Cleanup worker already running" });
    return;
  }
  startCleanupWorker();
  res.json({ message: "Cleanup worker started" });
});

// POST /api/admin/worker/cleanup/stop
router.post("/worker/cleanup/stop", (_req: Request, res: Response) => {
  if (!isCleanupRunning()) {
    res.json({ message: "Cleanup worker already stopped" });
    return;
  }
  stopCleanupWorker();
  res.json({ message: "Cleanup worker stopped" });
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
    cleanup: {
      running: isCleanupRunning(),
      maxAgeDays: config.storageCleanupAfterDays,
      intervalMinutes: config.storageCleanupIntervalMinutes,
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
      if (startDate) {
        const d = new Date(startDate as string);
        if (!isNaN(d.getTime())) query.createdAt.$gte = d;
      }
      if (endDate) {
        const d = new Date(endDate as string);
        if (!isNaN(d.getTime())) query.createdAt.$lte = d;
      }
      if (Object.keys(query.createdAt).length === 0) delete query.createdAt;
    }

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string, 10)));
    const skip = Math.min((pageNum - 1) * limitNum, 10000);

    const sort: Record<string, 1 | -1> = query.status === "pending"
      ? { priority: 1, createdAt: 1 }
      : { createdAt: -1 };

    const [jobs, total] = await Promise.all([
      Job.find(query).sort(sort).skip(skip).limit(limitNum).select("-replayIds").lean(),
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
    if (jobIds.length > 200) {
      res.status(400).json({ error: "jobIds array exceeds maximum of 200" });
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
      job.filter = parseFilter(filter);
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

    // Clean up storage object if it exists
    if (job.r2Key) {
      try {
        await deleteFromStorage(job.r2Key);
      } catch (err) {
        console.error(`Failed to delete storage key ${job.r2Key}:`, (err as Error).message);
      }
    }

    // Clean up local temp files
    cleanupJobTemp(job._id.toString());

    if (req.query.purge === "true") {
      await job.deleteOne();
      res.json({ message: "Job deleted" });
    } else {
      job.status = "cancelled";
      job.progress = null;
      await job.save();
      res.json({ message: "Job cancelled and cleaned up" });
    }
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
    const { count, rawSize } = await queryCountAndSize(job.filter);
    const estimates = calculateEstimates(count, rawSize);

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
    job.estimatedProcessingTime = estimates.estimatedProcessingTimeSec;
    job.completedAt = null;
    await job.save();

    res.json({ jobId: job._id, status: job.status });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/admin/storage/cleanup — on-demand expired job cleanup (DB-only, B2 lifecycle handles objects)
router.post("/storage/cleanup", async (req: Request, res: Response) => {
  try {
    const rawDays = Number(req.body.maxAgeDays ?? config.storageCleanupAfterDays);
    const maxAgeDays = Number.isFinite(rawDays) && rawDays >= 1 ? Math.floor(rawDays) : config.storageCleanupAfterDays;
    const dryRun = !!req.body.dryRun;

    const result = await cleanupExpiredJobs(maxAgeDays, dryRun);
    res.json({
      dryRun,
      maxAgeDays,
      ...result,
      freedMb: Math.round(result.freedBytes / (1024 * 1024)),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/admin/temp/cleanup — clean orphaned temp files
router.post("/temp/cleanup", async (req: Request, res: Response) => {
  try {
    const rawHours = Number(req.body.maxAgeHours ?? 24);
    const maxAgeHours = Number.isFinite(rawHours) && rawHours >= 1 ? rawHours : 24;
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
