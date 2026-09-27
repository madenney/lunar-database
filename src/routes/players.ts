import { Router, Request, Response } from "express";
import { Player } from "../models/Player";
import { PlayerStats } from "../models/PlayerStats";
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

    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 10));
    const query = (q as string)?.trim() || "";

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let results;
    if (query.length === 0) {
      // No query — return top players by game count
      results = await Player.find({})
        .sort({ gameCount: -1 })
        .limit(limitNum)
        .select("connectCode displayName tag aliases gameCount -_id")
        .maxTimeMS(5000)
        .lean();
    } else {
      const prefixRegex = new RegExp(`^${escapeRe(query)}`, "i");
      const or: any[] = [
        { connectCode: prefixRegex },
        { displayName: prefixRegex },
        // Collection folder names (netplay/<name>), e.g. "Eikelmann" -> TX#490.
        { aliases: prefixRegex },
      ];

      // Tag-overshoot: players often type MORE than the stored connect-code tag —
      // e.g. "mango" when the player is MANG#0 ("mang", 54k games). A plain
      // "^mango" prefix never matches "MANG#…", so it gets buried under unrelated
      // "Mango…" display names. Here we also match connect codes whose TAG (the
      // part before '#') is a *prefix* of the query, then let the gameCount sort
      // float the real player to the top. Only for queries ≥4 chars, tags ≥3.
      if (query.length >= 4) {
        const tagPrefixes: string[] = [];
        for (let n = 3; n < query.length; n++) tagPrefixes.push(escapeRe(query.slice(0, n)));
        or.push({ connectCode: new RegExp(`^(${tagPrefixes.join("|")})#`, "i") });
      }

      results = await Player.find({ $or: or })
        .sort({ gameCount: -1 })
        .limit(limitNum)
        .select("connectCode displayName tag aliases gameCount -_id")
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

    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 20));
    const escaped = (q as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixRegex = new RegExp(`^${escaped}`, "i");

    const results = await Player.find({
      $or: [
        { connectCode: prefixRegex },
        { displayName: prefixRegex },
        // Collection folder names (netplay/<name>), e.g. "Eikelmann" -> TX#490.
        { aliases: prefixRegex },
      ],
    })
      .sort({ gameCount: -1 })
      .limit(limitNum)
      .select("connectCode displayName tag aliases gameCount -_id")
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

const profileLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

/** Slippi connect codes: letters/digits, "#", digits (case-insensitive in URLs). */
const CONNECT_CODE = /^[A-Z0-9]{1,8}#[0-9]{1,6}$/;

// GET /api/players/:code/profile — career stats for one connect code (1v1 games),
// built by npm run build-player-stats. :code is URL-encoded, e.g. MANG%230.
// Privacy: Slippi user IDs, the codes they link (a player's code history) and
// former display names are stored but not served until players can verify their
// accounts and choose what to show. Only primary names are public.
router.get("/:code/profile", profileLimiter, async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code).toUpperCase();
    if (!CONNECT_CODE.test(code)) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    const profile = await PlayerStats.findOne({ connectCode: code }).select({ _id: 0, __v: 0, userIds: 0, otherCodes: 0 }).lean();
    if (!profile) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    // Only each player's primary (most used) name is public: former names can be
    // ones a player chose to leave behind. Opponents are named the same way.
    const opponentCodes = (profile.opponents ?? []).map((o) => o.connectCode);
    const primaries = new Map(
      (await PlayerStats.find({ connectCode: { $in: opponentCodes } }).select({ connectCode: 1, names: { $slice: 1 } }).lean()).map(
        (o) => [o.connectCode, o.names?.[0]?.name ?? null]
      )
    );
    res.json({
      ...profile,
      names: (profile.names ?? []).slice(0, 1),
      opponents: (profile.opponents ?? []).map((o) => ({ ...o, name: primaries.get(o.connectCode) ?? null })),
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
