import { Router, Request, Response } from "express";
import path from "path";
import { Replay } from "../models/Replay";

const router = Router();

// GET /api/replays — search/filter replays
router.get("/", async (req: Request, res: Response) => {
  try {
    const {
      stageId,
      startDate,
      endDate,
      sort,
      p1CharacterId, p1ConnectCode, p1DisplayName,
      p2CharacterId, p2ConnectCode, p2DisplayName,
      page = "1",
      limit = "50",
    } = req.query;

    // Exclude junk replays: must have a known stage or at least one known character
    const notJunk = {
      $or: [
        { stageId: { $ne: null } },
        { "players.characterId": { $ne: null } },
      ],
      "players.0": { $exists: true },
    };

    const query: any = {};

    // Build per-player $elemMatch conditions
    // All filter params accept comma-separated values for multi-select
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const splitParam = (v: string | undefined) => v ? (v as string).split(",").filter(Boolean) : [];

    const p1CharIds = splitParam(p1CharacterId as string | undefined);
    const p1Codes = splitParam(p1ConnectCode as string | undefined);
    const p1Names = splitParam(p1DisplayName as string | undefined);
    const p2CharIds = splitParam(p2CharacterId as string | undefined);
    const p2Codes = splitParam(p2ConnectCode as string | undefined);
    const p2Names = splitParam(p2DisplayName as string | undefined);

    const p1Match: any = {};
    if (p1CharIds.length === 1) p1Match.characterId = Number(p1CharIds[0]);
    else if (p1CharIds.length > 1) p1Match.characterId = { $in: p1CharIds.map(Number) };
    if (p1Codes.length === 1) p1Match.connectCode = p1Codes[0];
    else if (p1Codes.length > 1) p1Match.connectCode = { $in: p1Codes };
    if (p1Names.length === 1) {
      p1Match.displayName = { $regex: `^${escapeRegex(p1Names[0])}`, $options: "i" };
    } else if (p1Names.length > 1) {
      p1Match.displayName = { $regex: `^(${p1Names.map(escapeRegex).join("|")})`, $options: "i" };
    }

    const p2Match: any = {};
    if (p2CharIds.length === 1) p2Match.characterId = Number(p2CharIds[0]);
    else if (p2CharIds.length > 1) p2Match.characterId = { $in: p2CharIds.map(Number) };
    if (p2Codes.length === 1) p2Match.connectCode = p2Codes[0];
    else if (p2Codes.length > 1) p2Match.connectCode = { $in: p2Codes };
    if (p2Names.length === 1) {
      p2Match.displayName = { $regex: `^${escapeRegex(p2Names[0])}`, $options: "i" };
    } else if (p2Names.length > 1) {
      p2Match.displayName = { $regex: `^(${p2Names.map(escapeRegex).join("|")})`, $options: "i" };
    }

    // Prefix a match object's keys with an array position, e.g. { characterId: 20 } → { "players.0.characterId": 20 }
    const prefixMatch = (match: any, prefix: string): any => {
      const result: any = {};
      for (const [key, value] of Object.entries(match)) {
        result[`${prefix}.${key}`] = value;
      }
      return result;
    };

    const hasP1 = Object.keys(p1Match).length > 0;
    const hasP2 = Object.keys(p2Match).length > 0;
    if (hasP1 && hasP2) {
      // Use positional queries with $or so p1 and p2 must match DIFFERENT players
      query.$or = [
        { ...prefixMatch(p1Match, "players.0"), ...prefixMatch(p2Match, "players.1") },
        { ...prefixMatch(p1Match, "players.1"), ...prefixMatch(p2Match, "players.0") },
      ];
    } else if (hasP1) {
      query.players = { $elemMatch: p1Match };
    } else if (hasP2) {
      query.players = { $elemMatch: p2Match };
    }

    // Combine junk filter with query using $and so it doesn't clash with player $or
    const finalQuery = { $and: [notJunk, query] };

    const stageIds = splitParam(stageId as string | undefined);
    if (stageIds.length === 1) {
      query.stageId = Number(stageIds[0]);
    } else if (stageIds.length > 1) {
      query.stageId = { $in: stageIds.map(Number) };
    }
    if (startDate || endDate) {
      query.startAt = {};
      if (startDate) query.startAt.$gte = new Date(startDate as string);
      if (endDate) query.startAt.$lte = new Date(endDate as string);
    }

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
    console.log("LIMIT DEBUG:", limit, "→", limitNum);
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
