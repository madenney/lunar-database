import { Router, Request, Response } from "express";
import { Player } from "../models/Player";
import { SearchEvent } from "../models/SearchEvent";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";

const router = Router();

const playerSearchLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many player search requests, please try again later" },
});

// GET /api/players/autocomplete?q=FOX — fast autocomplete for connect codes and display names
router.get("/autocomplete", playerSearchLimiter, async (req: Request, res: Response) => {
  try {
    const { q, limit = "10" } = req.query;
    if ((q as string)?.length > 100) {
      res.status(400).json({ error: "Query too long (max 100 characters)" });
      return;
    }

    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const query = (q as string)?.trim() || "";

    let results;
    if (query.length === 0) {
      // No query — return top players by game count
      results = await Player.find({})
        .sort({ gameCount: -1 })
        .limit(limitNum)
        .select("connectCode displayName tag gameCount -_id")
        .maxTimeMS(5000)
        .lean();
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefixRegex = new RegExp(`^${escaped}`, "i");
      results = await Player.find({
        $or: [
          { connectCode: prefixRegex },
          { displayName: prefixRegex },
        ],
      })
        .sort({ gameCount: -1 })
        .limit(limitNum)
        .select("connectCode displayName tag gameCount -_id")
        .maxTimeMS(5000)
        .lean();
    }

    const clientId = req.headers["x-client-id"] as string | undefined;
    SearchEvent.create({
      type: "player_search",
      clientId: clientId || null,
      query: query || null,
      resultCount: results.length,
    }).catch(() => {});

    res.json(results);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/players/search?q=AKLO — search players by connect code or display name
router.get("/search", playerSearchLimiter, async (req: Request, res: Response) => {
  try {
    const { q, limit = "20" } = req.query;
    if (!q || (q as string).length < 2) {
      res.status(400).json({ error: "Query must be at least 2 characters" });
      return;
    }
    if ((q as string).length > 100) {
      res.status(400).json({ error: "Query too long (max 100 characters)" });
      return;
    }

    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const escaped = (q as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixRegex = new RegExp(`^${escaped}`, "i");

    const results = await Player.find({
      $or: [
        { connectCode: prefixRegex },
        { displayName: prefixRegex },
      ],
    })
      .sort({ gameCount: -1 })
      .limit(limitNum)
      .select("connectCode displayName tag gameCount -_id")
      .maxTimeMS(5000)
      .lean();

    const clientId = req.headers["x-client-id"] as string | undefined;
    SearchEvent.create({
      type: "player_search",
      clientId: clientId || null,
      query: (q as string) || null,
      resultCount: results.length,
    }).catch(() => {});

    res.json(results);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
