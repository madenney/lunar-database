import { Router, Request, Response } from "express";
import path from "path";
import { Replay } from "../models/Replay";
import { buildReplaySearchQuery, ReplaySearchParams } from "../services/replaySearchQuery";
import { config } from "../config";

const router = Router();

// POST /api/replays/estimate — estimate count, size, and ETA for a filter
router.post("/estimate", async (req: Request, res: Response) => {
  try {
    const params: ReplaySearchParams = req.body;

    // Require at least one filter
    const hasFilter = !!(
      params.p1CharacterId || params.p1ConnectCode || params.p1DisplayName ||
      params.p2CharacterId || params.p2ConnectCode || params.p2DisplayName ||
      params.stageId || params.startDate || params.endDate
    );
    if (!hasFilter) {
      res.status(400).json({ error: "At least one filter is required" });
      return;
    }

    const query = buildReplaySearchQuery(params);

    const [count, sizeAgg] = await Promise.all([
      Replay.countDocuments(query),
      Replay.aggregate([
        { $match: query },
        { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
      ]),
    ]);

    const rawSize = sizeAgg[0]?.totalSize ?? 0;
    const estimatedCompressedSize = Math.round(rawSize / 8);

    // ETA: compression time + upload time
    const COMPRESS_RATE = 120; // files per second
    const uploadSpeedBytes = (config.estimateUploadSpeedMbps * 1024 * 1024) / 8; // Mbps → bytes/sec
    const compressTimeSec = count / COMPRESS_RATE;
    const uploadTimeSec = estimatedCompressedSize / uploadSpeedBytes;
    const estimatedTimeSec = Math.round(compressTimeSec + uploadTimeSec);

    res.json({
      replayCount: count,
      rawSize,
      estimatedCompressedSize,
      estimatedTimeSec,
      exceedsLimit: count > config.jobMaxReplays,
      limit: config.jobMaxReplays,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/replays — search/filter replays
router.get("/", async (req: Request, res: Response) => {
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
    const limitNum = Math.max(1, parseInt(limit as string, 10));
    const skip = (pageNum - 1) * limitNum;

    const [replays, total] = await Promise.all([
      Replay.find(finalQuery).sort(sortObj).skip(skip).limit(limitNum).lean(),
      Replay.countDocuments(finalQuery),
    ]);

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
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/replays/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const replay = await Replay.findById(req.params.id).lean();
    if (!replay) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    res.json(replay);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/replays/:id/download — serve the .slp file directly
router.get("/:id/download", async (req: Request, res: Response) => {
  try {
    const replay = await Replay.findById(req.params.id).lean();
    if (!replay) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    res.download(replay.filePath, path.basename(replay.filePath));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
