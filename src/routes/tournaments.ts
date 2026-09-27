import { Router, Request, Response } from "express";
import { Tournament } from "../models/Tournament";
import { TournamentSet } from "../models/TournamentSet";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";

const router = Router();

const limiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

/** Set fields served publicly (the archive folder stays internal). */
export const PUBLIC_SET_FIELDS = { dir: 0, builtAt: 0, __v: 0 } as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/tournaments?q=&page=&limit=&sort=recent|games — listed tournaments.
router.get("/", limiter, async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const page = Math.max(1, Math.min(Number(req.query.page) || 1, 1000));
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
    const filter: Record<string, unknown> = { listed: true };
    // Every word must appear, ignoring punctuation: "kotj 7" finds "KOTJ #7". Numbers
    // match whole, so "7" doesn't find "#17" or "2017".
    const words = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
    if (words.length) {
      filter.$and = words.map((w) => ({
        name: { $regex: /^\d+$/.test(w) ? `(^|\\D)${w}(\\D|$)` : escapeRegex(w), $options: "i" },
      }));
    }
    const sort: Record<string, 1 | -1> = req.query.sort === "games" ? { games: -1 } : { lastAt: -1, games: -1 };
    const [tournaments, total] = await Promise.all([
      Tournament.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .select({ name: 1, location: 1, firstAt: 1, lastAt: 1, games: 1, sets: 1, startggSlug: 1, characters: { $slice: 3 } })
        .lean(),
      Tournament.countDocuments(filter),
    ]);
    res.json({ tournaments, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/tournaments/:key — a listed tournament's summary and its sets.
router.get("/:key", limiter, async (req: Request, res: Response) => {
  try {
    const key = String(req.params.key).toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(key)) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }
    const tournament = await Tournament.findOne({ _id: key, listed: true }).select({ __v: 0, builtAt: 0 }).lean();
    if (!tournament) {
      res.status(404).json({ error: "Tournament not found" });
      return;
    }
    const sets =
      req.query.sets === "0"
        ? []
        : await TournamentSet.find({ tournamentKey: key }).select(PUBLIC_SET_FIELDS).sort({ startAt: 1, _id: 1 }).limit(3000).lean();
    res.json({ tournament, sets });
  } catch (err) {
    sendError(res, err);
  }
});

export const setsRouter = Router();

// GET /api/sets/:id — one set with its games in order.
setsRouter.get("/:id", limiter, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!/^(sgg-\d{1,12}|dir-[0-9a-f]{20})$/.test(id)) {
      res.status(404).json({ error: "Set not found" });
      return;
    }
    const set = await TournamentSet.findById(id).select(PUBLIC_SET_FIELDS).lean();
    if (!set) {
      res.status(404).json({ error: "Set not found" });
      return;
    }
    res.json(set);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
