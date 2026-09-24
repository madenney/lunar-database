import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Replay } from "../models/Replay";
import { resolveSelection, ReplaySearchParams } from "../services/replaySearchQuery";
import { parseFilter, hasFilterOrLimit } from "../services/replayFilter";
import { sendApiError } from "../utils/apiErrors";
import { config } from "../config";
import { DownloadEvent } from "../models/DownloadEvent";
import { SearchEvent } from "../models/SearchEvent";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";
import { sanitizeFilters } from "../utils/sanitizeFilters";

const router = Router();

const searchLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many search requests, please try again later" },
});

const estimateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: "Too many estimate requests, please try again later" },
});

// POST /api/replays/estimate — estimate count, size, and ETA for a filter
router.post("/estimate", estimateLimiter, async (req: Request, res: Response) => {
  try {
    // Parse exactly as job creation does, so the estimate describes the bundle.
    const params: ReplaySearchParams = parseFilter(req.body ?? {});

    // A limit on its own is enough: the query is bounded by it, so it's safe (and
    // useful) to estimate.
    const { hasFilter, hasLimit } = hasFilterOrLimit(params);
    if (!hasFilter && !hasLimit) {
      sendApiError(res, 400, "filter_required");
      return;
    }

    const { count, rawSize, totalDurationFrames } = await queryCountAndSize(params, { includeDuration: true });
    const estimates = calculateEstimates(count, rawSize);

    const clientId = req.headers["x-client-id"] as string | undefined;
    SearchEvent.create({
      type: "estimate",
      clientId: clientId || null,
      filters: sanitizeFilters(params),
      estimatedCount: count,
      estimatedSize: rawSize,
    }).catch(() => {});

    res.json({
      replayCount: count,
      rawSize,
      estimatedSlpzSize: Math.round(rawSize / 8),
      estimatedZipSize: estimates.estimatedZipSize,
      estimatedTimeSec: estimates.estimatedProcessingTimeSec,
      totalDurationFrames,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/replays — search/filter replays
router.get("/", searchLimiter, async (req: Request, res: Response) => {
  try {
    const {
      sort,
      page = "1",
      limit = "50",
    } = req.query;

    const params: ReplaySearchParams = {
      p1CharacterId: req.query.p1CharacterId as string | undefined,
      p1ConnectCode: req.query.p1ConnectCode as string | undefined,
      p1DisplayName: req.query.p1DisplayName as string | undefined,
      p1Rank: req.query.p1Rank as string | undefined,
      p2CharacterId: req.query.p2CharacterId as string | undefined,
      p2ConnectCode: req.query.p2ConnectCode as string | undefined,
      p2DisplayName: req.query.p2DisplayName as string | undefined,
      p2Rank: req.query.p2Rank as string | undefined,
      stageId: req.query.stageId as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      source: req.query.source as string | undefined,
    };

    // Same selection as estimate, job creation and the bundle worker, including
    // how ascending date order treats undated replays.
    const { query: finalQuery, sortObj } = await resolveSelection({ ...params, sort: sort as string | undefined });

    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    // Cap matches the frontend's largest page-size option (1,000). Anything
    // above is clamped so a single response can't blow up.
    const limitNum = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, rawLimit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    const [replays, total] = await Promise.all([
      Replay.find(finalQuery).select("-filePath").sort(sortObj).skip(skip).limit(limitNum).maxTimeMS(10000).lean(),
      Replay.countDocuments(finalQuery).maxTimeMS(10000),
    ]);

    const clientId = req.headers["x-client-id"] as string | undefined;
    SearchEvent.create({
      type: "search",
      clientId: clientId || null,
      filters: sanitizeFilters(params),
      resultCount: total,
      page: pageNum,
      limit: limitNum,
    }).catch(() => {});

    res.json({
      replays,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});

const replayGetLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

// GET /api/replays/:id
router.get("/:id", replayGetLimiter, async (req: Request, res: Response) => {
  try {
    const replay = await Replay.findById(req.params.id).select("-filePath").lean();
    if (!replay) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    res.json(replay);
  } catch (err) {
    sendError(res, err);
  }
});

const viewLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

// POST /api/replays/:id/view — record one in-browser watch. Denormalized counter;
// callers dedupe per session, so this is a plain increment. Returns the new count.
router.post("/:id/view", viewLimiter, async (req: Request, res: Response) => {
  try {
    const updated = await Replay.findByIdAndUpdate(
      req.params.id,
      { $inc: { viewCount: 1 } },
      { new: true, projection: { viewCount: 1 } },
    ).lean();
    if (!updated) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    res.json({ viewCount: updated.viewCount });
  } catch (err) {
    sendError(res, err);
  }
});

const downloadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many download requests, please try again later" },
});

// GET /api/replays/:id/download — serve the .slp file directly
router.get("/:id/download", downloadLimiter, async (req: Request, res: Response) => {
  try {
    const replay = await Replay.findById(req.params.id).lean();
    if (!replay) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    const rootDir = fs.realpathSync(config.slpRootDir);
    const resolved = fs.realpathSync(path.resolve(rootDir, replay.filePath));
    if (!resolved.startsWith(rootDir + path.sep)) {
      res.status(403).json({ error: "File path outside allowed directory" });
      return;
    }
    // Log download event for analytics
    const clientId = req.headers["x-client-id"] as string | undefined;
    DownloadEvent.create({
      type: "replay",
      replayId: replay._id,
      clientId: clientId || null,
      bundleSize: replay.fileSize || null,
      replayCount: 1,
    }).catch(() => {});

    res.download(resolved, path.basename(resolved));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
