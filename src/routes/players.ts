import { Router, Request, Response } from "express";
import { Player } from "../models/Player";
import { sendError } from "../utils/sendError";

const router = Router();

// GET /api/players/autocomplete?q=FOX — fast autocomplete for connect codes and display names
router.get("/autocomplete", async (req: Request, res: Response) => {
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
        .lean();
    }

    res.json(results);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/players/search?q=AKLO — search players by connect code or display name
router.get("/search", async (req: Request, res: Response) => {
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
      .lean();

    res.json(results);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
