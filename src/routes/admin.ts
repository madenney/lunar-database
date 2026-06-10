import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
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
import { SearchEvent } from "../models/SearchEvent";
import { DownloadEvent } from "../models/DownloadEvent";
import { blacklistToken } from "../services/tokenBlacklist";
import { cleanupExpiredJobs } from "../services/storageCleanup";
import { deleteFromStorage } from "../services/storage";
import { pinBundle, unpinBundle, PinError } from "../services/pinBundle";
import { cleanupJobTemp, getTempDiskUsage, cleanupOrphanedTemp } from "../services/bundler";
import { runHealthChecks } from "../services/healthCheck";
import { parseFilter } from "./jobs";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";
import { createRateLimiter } from "../utils/rateLimiter";

const adminMutationLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many admin operations, please try again later" },
});

const analyticsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: "Too many analytics requests, please try again later" },
});

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
      console.warn(`[AUTH] Failed login — unknown user "${username}" from ${req.ip}`);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (!(await admin.comparePassword(password))) {
      console.warn(`[AUTH] Failed login — bad password for "${username}" from ${req.ip}`);
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    console.log(`[AUTH] Successful login for "${username}" from ${req.ip}`);

    const jti = crypto.randomUUID();
    const token = jwt.sign(
      { adminId: admin._id.toString(), username: admin.username, jti },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn, algorithm: "HS256" }
    );

    res.json({ token, username: admin.username });
  } catch (err) {
    sendError(res, err);
  }
});

// All routes below require admin auth
router.use(requireAdmin);

// Audit logging for all admin operations
router.use((req: Request, _res: Response, next) => {
  const level = req.method === "GET" ? "debug" : "log";
  console[level](`[ADMIN] ${req.admin?.username} ${req.method} ${req.path}`);
  next();
});

// POST /api/admin/logout — revoke the current token
router.post("/logout", async (req: Request, res: Response) => {
  try {
    const payload = req.admin!;
    if (payload.jti) {
      const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);
      await blacklistToken(payload.jti, expiresAt);
    }
    res.json({ message: "Logged out" });
  } catch (err) {
    sendError(res, err);
  }
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

// GET /api/admin/health — active end-to-end health check (DB, replay drive,
// compressor binary, object storage, disk, temp dir, workers). Unlike /status,
// this actually exercises each dependency so "healthy" means jobs can run.
router.get("/health", async (_req: Request, res: Response) => {
  try {
    res.json(await runHealthChecks());
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

    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    const limitNum = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
    const skip = (pageNum - 1) * limitNum;

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
router.get("/jobs/queue", analyticsLimiter, async (_req: Request, res: Response) => {
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
router.put("/jobs/reorder", adminMutationLimiter, async (req: Request, res: Response) => {
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
router.patch("/jobs/:id", adminMutationLimiter, async (req: Request, res: Response) => {
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
      // Only allow specific state transitions to prevent corruption
      const ADMIN_TRANSITIONS: Record<string, string[]> = {
        pending: ["cancelled"],
        processing: ["cancelled", "failed"],
        compressing: ["cancelled", "failed"],
        compressed: ["cancelled", "failed"],
        uploading: ["cancelled", "failed"],
        completed: [],
        failed: ["pending"],
        cancelled: ["pending"],
      };
      const allowed = ADMIN_TRANSITIONS[job.status] ?? [];
      if (!allowed.includes(status)) {
        res.status(400).json({
          error: `Cannot transition from '${job.status}' to '${status}'. Allowed: ${allowed.join(", ") || "none"}`,
        });
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
router.delete("/jobs/:id", adminMutationLimiter, async (req: Request, res: Response) => {
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
router.post("/jobs/:id/retry", adminMutationLimiter, async (req: Request, res: Response) => {
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

// POST /api/admin/jobs/:id/pin — move bundle to permanent archive/ prefix (exempt from expiry)
router.post("/jobs/:id/pin", adminMutationLimiter, async (req: Request, res: Response) => {
  try {
    const result = await pinBundle(req.params.id as string);
    res.json(result);
  } catch (err) {
    if (err instanceof PinError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendError(res, err);
  }
});

// POST /api/admin/jobs/:id/unpin — return bundle to ephemeral jobs/ prefix (resumes normal expiry)
router.post("/jobs/:id/unpin", adminMutationLimiter, async (req: Request, res: Response) => {
  try {
    const result = await unpinBundle(req.params.id as string);
    res.json(result);
  } catch (err) {
    if (err instanceof PinError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendError(res, err);
  }
});

// POST /api/admin/storage/cleanup — on-demand expired job cleanup (DB-only, B2 lifecycle handles objects)
router.post("/storage/cleanup", adminMutationLimiter, async (req: Request, res: Response) => {
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
router.post("/temp/cleanup", adminMutationLimiter, async (req: Request, res: Response) => {
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

// ── Analytics ──────────────────────────────────────────────────────────

function buildDateFilter(startDate?: string, endDate?: string) {
  const filter: Record<string, any> = {};
  if (startDate) {
    const d = new Date(startDate);
    if (!isNaN(d.getTime())) filter.$gte = d;
  }
  if (endDate) {
    const d = new Date(endDate);
    if (!isNaN(d.getTime())) filter.$lte = d;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

// GET /api/admin/analytics/overview — high-level stats for a time range
router.get("/analytics/overview", analyticsLimiter, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const dateFilter = buildDateFilter(startDate as string, endDate as string);
    const dateMatch = dateFilter ? { createdAt: dateFilter } : {};

    const [searchStats, downloadStats, uniqueSearchClients, uniqueDownloadClients] = await Promise.all([
      SearchEvent.aggregate([
        { $match: dateMatch },
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
          },
        },
      ]).option({ maxTimeMS: 30000 }),
      DownloadEvent.aggregate([
        { $match: dateMatch },
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
            totalBytes: { $sum: "$bundleSize" },
            totalReplays: { $sum: "$replayCount" },
          },
        },
      ]).option({ maxTimeMS: 30000 }),
      // Separate bounded query for unique client counts
      SearchEvent.distinct("clientId", { ...dateMatch, clientId: { $ne: null } }).maxTimeMS(30000),
      DownloadEvent.distinct("clientId", { ...dateMatch, clientId: { $ne: null } }).maxTimeMS(30000),
    ]);

    const searches: Record<string, any> = {};
    for (const s of searchStats) {
      searches[s._id] = { count: s.count };
    }

    const downloads: Record<string, any> = {};
    for (const d of downloadStats) {
      downloads[d._id] = {
        count: d.count,
        totalBytes: d.totalBytes,
        totalReplays: d.totalReplays,
      };
    }

    res.json({
      searches,
      downloads,
      totalSearchEvents: searchStats.reduce((sum, s) => sum + s.count, 0),
      totalDownloadEvents: downloadStats.reduce((sum, d) => sum + d.count, 0),
      uniqueSearchClients: uniqueSearchClients.length,
      uniqueDownloadClients: uniqueDownloadClients.length,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/analytics/activity — daily event counts over time
router.get("/analytics/activity", analyticsLimiter, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, granularity = "day" } = req.query;
    const dateFilter = buildDateFilter(startDate as string, endDate as string);
    const dateMatch = dateFilter ? { createdAt: dateFilter } : {};

    const VALID_GRANULARITIES = ["hour", "day"];
    if (!VALID_GRANULARITIES.includes(granularity as string)) {
      res.status(400).json({ error: "Invalid granularity (must be 'hour' or 'day')" });
      return;
    }
    const dateFormat = granularity === "hour" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";

    const [searchActivity, downloadActivity] = await Promise.all([
      SearchEvent.aggregate([
        { $match: dateMatch },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: dateFormat, date: "$createdAt" } },
              type: "$type",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.date": 1 } },
      ]).option({ maxTimeMS: 30000 }),
      DownloadEvent.aggregate([
        { $match: dateMatch },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: dateFormat, date: "$createdAt" } },
              type: "$type",
            },
            count: { $sum: 1 },
            totalBytes: { $sum: "$bundleSize" },
          },
        },
        { $sort: { "_id.date": 1 } },
      ]).option({ maxTimeMS: 30000 }),
    ]);

    res.json({
      searches: searchActivity.map((r) => ({ date: r._id.date, type: r._id.type, count: r.count })),
      downloads: downloadActivity.map((r) => ({
        date: r._id.date,
        type: r._id.type,
        count: r.count,
        totalBytes: r.totalBytes,
      })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/analytics/top-searches — most popular search filters and player queries
router.get("/analytics/top-searches", analyticsLimiter, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, limit = "10" } = req.query;
    const dateFilter = buildDateFilter(startDate as string, endDate as string);
    const dateMatch = dateFilter ? { createdAt: dateFilter } : {};
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));

    const [topConnectCodes, topCharacters, topStages, topPlayerQueries, zeroResultSearches] = await Promise.all([
      // Top connect codes searched
      SearchEvent.aggregate([
        { $match: { ...dateMatch, type: { $in: ["search", "estimate"] } } },
        {
          $project: {
            codes: {
              $filter: {
                input: [
                  "$filters.p1ConnectCode",
                  "$filters.p2ConnectCode",
                ],
                cond: { $ne: ["$$this", null] },
              },
            },
          },
        },
        { $unwind: "$codes" },
        { $group: { _id: "$codes", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limitNum },
      ]).option({ maxTimeMS: 30000 }),
      // Top characters searched
      SearchEvent.aggregate([
        { $match: { ...dateMatch, type: { $in: ["search", "estimate"] } } },
        {
          $project: {
            chars: {
              $filter: {
                input: [
                  "$filters.p1CharacterId",
                  "$filters.p2CharacterId",
                ],
                cond: { $ne: ["$$this", null] },
              },
            },
          },
        },
        { $unwind: "$chars" },
        { $group: { _id: "$chars", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limitNum },
      ]).option({ maxTimeMS: 30000 }),
      // Top stages searched
      SearchEvent.aggregate([
        { $match: { ...dateMatch, type: { $in: ["search", "estimate"] }, "filters.stageId": { $ne: null } } },
        { $group: { _id: "$filters.stageId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limitNum },
      ]).option({ maxTimeMS: 30000 }),
      // Top player search queries
      SearchEvent.aggregate([
        { $match: { ...dateMatch, type: "player_search", query: { $ne: null } } },
        { $group: { _id: { $toLower: "$query" }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: limitNum },
      ]).option({ maxTimeMS: 30000 }),
      // Searches that returned 0 results
      SearchEvent.aggregate([
        { $match: { ...dateMatch, resultCount: 0 } },
        {
          $group: {
            _id: "$type",
            count: { $sum: 1 },
          },
        },
      ]).option({ maxTimeMS: 30000 }),
    ]);

    res.json({
      topConnectCodes: topConnectCodes.map((r) => ({ connectCode: r._id, count: r.count })),
      topCharacters: topCharacters.map((r) => ({ characterId: r._id, count: r.count })),
      topStages: topStages.map((r) => ({ stageId: r._id, count: r.count })),
      topPlayerQueries: topPlayerQueries.map((r) => ({ query: r._id, count: r.count })),
      zeroResultSearches: zeroResultSearches.reduce((acc, r) => { acc[r._id] = r.count; return acc; }, {} as Record<string, number>),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/analytics/top-clients — most active clients (abuse / power-user detection)
router.get("/analytics/top-clients", analyticsLimiter, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, limit = "20" } = req.query;
    const dateFilter = buildDateFilter(startDate as string, endDate as string);
    const dateMatch = dateFilter ? { createdAt: dateFilter } : {};
    const rawLimit = parseInt(limit as string, 10);
    const limitNum = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;

    const [searchByClient, downloadByClient] = await Promise.all([
      SearchEvent.aggregate([
        { $match: dateMatch },
        { $group: { _id: "$clientId", searches: { $sum: 1 } } },
      ]).option({ maxTimeMS: 30000 }),
      DownloadEvent.aggregate([
        { $match: dateMatch },
        {
          $group: {
            _id: "$clientId",
            downloads: { $sum: 1 },
            totalBytes: { $sum: "$bundleSize" },
            totalReplays: { $sum: "$replayCount" },
          },
        },
      ]).option({ maxTimeMS: 30000 }),
    ]);

    // Merge the two per-client rollups. clientId may be null (no X-Client-Id
    // header sent) — those collapse into a single "anonymous" bucket, which is
    // itself a useful signal (e.g. header-less scraping).
    const byClient = new Map<string | null, any>();
    const slot = (id: string | null) => {
      if (!byClient.has(id)) {
        byClient.set(id, { clientId: id, searches: 0, downloads: 0, totalBytes: 0, totalReplays: 0 });
      }
      return byClient.get(id);
    };
    for (const s of searchByClient) slot(s._id ?? null).searches = s.searches;
    for (const d of downloadByClient) {
      const c = slot(d._id ?? null);
      c.downloads = d.downloads;
      c.totalBytes = d.totalBytes || 0;
      c.totalReplays = d.totalReplays || 0;
    }

    const clients = Array.from(byClient.values())
      .map((c) => ({ ...c, totalEvents: c.searches + c.downloads }))
      .sort((a, b) => b.totalEvents - a.totalEvents)
      .slice(0, limitNum);

    res.json({ clients });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/analytics/searches — paginated search event log
router.get("/analytics/searches", analyticsLimiter, async (req: Request, res: Response) => {
  try {
    const { type, clientId, startDate, endDate, page = "1", limit = "50" } = req.query;
    const query: Record<string, any> = {};

    if (type) query.type = String(type);
    if (clientId) query.clientId = String(clientId);
    const dateFilter = buildDateFilter(startDate as string, endDate as string);
    if (dateFilter) query.createdAt = dateFilter;

    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    const limitNum = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    const [events, total] = await Promise.all([
      SearchEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      SearchEvent.countDocuments(query),
    ]);

    res.json({
      events,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/admin/analytics/downloads — paginated download event log
router.get("/analytics/downloads", analyticsLimiter, async (req: Request, res: Response) => {
  try {
    const { type, clientId, startDate, endDate, page = "1", limit = "50" } = req.query;
    const query: Record<string, any> = {};

    if (type) query.type = String(type);
    if (clientId) query.clientId = String(clientId);
    const dateFilter = buildDateFilter(startDate as string, endDate as string);
    if (dateFilter) query.createdAt = dateFilter;

    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    const limitNum = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    const [events, total] = await Promise.all([
      DownloadEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      DownloadEvent.countDocuments(query),
    ]);

    res.json({
      events,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
