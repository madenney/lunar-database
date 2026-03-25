import { Router, Request, Response } from "express";
import path from "path";
import { Replay } from "../models/Replay";
import { buildReplaySearchQuery, ReplaySearchParams } from "../services/replaySearchQuery";
import { config } from "../config";
import { DownloadEvent } from "../models/DownloadEvent";
import { SearchEvent } from "../models/SearchEvent";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";

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
    const params: ReplaySearchParams = req.body;

    // Don't count maxFiles/maxSizeMb as filter fields
    const filterKeys = Object.keys(params).filter((k) => k !== "maxFiles" && k !== "maxSizeMb");
    if (filterKeys.length === 0) {
      res.status(400).json({ error: "At least one filter field is required" });
      return;
    }

    const { count, rawSize, totalDurationFrames } = await queryCountAndSize(params, { includeDuration: true });
    const estimates = calculateEstimates(count, rawSize);

    const clientId = req.headers["x-client-id"] as string | undefined;
    SearchEvent.create({
      type: "estimate",
      clientId: clientId || null,
      filters: params,
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
      p2CharacterId: req.query.p2CharacterId as string | undefined,
      p2ConnectCode: req.query.p2ConnectCode as string | undefined,
      p2DisplayName: req.query.p2DisplayName as string | undefined,
      stageId: req.query.stageId as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    };

    const finalQuery = buildReplaySearchQuery(params);

    // Parse sort param (format: "field:direction", e.g. "startAt:-1")
    const SORT_ALLOWLIST = ["startAt", "indexedAt", "duration"];
    let sortObj: Record<string, 1 | -1> = { startAt: -1 };
    if (sort) {
      const [field, dir] = (sort as string).split(":");
      if (SORT_ALLOWLIST.includes(field) && (dir === "1" || dir === "-1")) {
        sortObj = { [field]: Number(dir) as 1 | -1 };
      }
    }

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [replays, total] = await Promise.all([
      Replay.find(finalQuery).select("-filePath").sort(sortObj).skip(skip).limit(limitNum).maxTimeMS(10000).lean(),
      Replay.countDocuments(finalQuery).maxTimeMS(10000),
    ]);

    const clientId = req.headers["x-client-id"] as string | undefined;
    SearchEvent.create({
      type: "search",
      clientId: clientId || null,
      filters: params,
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

// GET /api/replays/:id
router.get("/:id", async (req: Request, res: Response) => {
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
    const resolved = path.resolve(config.slpRootDir, replay.filePath);
    if (!resolved.startsWith(path.resolve(config.slpRootDir) + path.sep)) {
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
