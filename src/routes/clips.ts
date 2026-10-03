/**
 * Clip search (docs/clip-search.md, Phase 1b): moments from the `clips`
 * collection built by scripts/buildClips.ts.
 *
 * POST /api/clips
 *   { type: "combo" | "edgeguard" | "quitout",            required
 *     attackerCharacterId, victimCharacterId,               comma lists or arrays (max 20)
 *     attackerConnectCode, victimConnectCode,
 *     stageId, source, startDate, endDate,
 *     minDamage, minMoves, killOnly, zeroToDeath, includeInfinites, withMoves,
 *     sort: "newest" (default) | "best" | "oldest", page, limit (max 100) }
 * -> { results, total, capped, page, limit }
 *
 * Every query starts with `type` and is served by an index (services/clips.ts
 * CLIP_INDEXES); counts stop at CLIP_COUNT_CAP ("10,000+") and results and
 * counts are cached, like game search. Clips carry only what game search
 * already shows per player (code, display name, character).
 */
import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { createRateLimiter } from "../utils/rateLimiter";
import { sendError } from "../utils/sendError";
import { heavyQueries, paramsKey } from "../services/queryCache";
import { sendApiError } from "../utils/apiErrors";
import { parseClipSearch, applyTournamentFilter, CLIP_COUNT_CAP } from "../services/clipSearch";

export { parseClipSearch, CLIP_TYPES, CLIP_COUNT_CAP, type ClipSearch } from "../services/clipSearch";

const router = Router();

const clipsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many clip searches, please try again later" },
});

const RESULT_FIELDS = {
  replayId: 1, type: 1, startFrame: 1, endFrame: 1, gameFrames: 1, stageId: 1, source: 1, startAt: 1,
  attacker: 1, victim: 1, startPercent: 1, endPercent: 1, damage: 1, moves: 1, didKill: 1,
  score: 1, rank: 1, metrics: 1, infinite: 1,
};

router.post("/", clipsLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = parseClipSearch(req.body ?? {});
    if ("error" in parsed) {
      sendApiError(res, 400, "invalid_request", { error: parsed.error });
      return;
    }
    const { filter, sort, page, limit } = parsed;
    const hint = await applyTournamentFilter(filter, req.body ?? {});
    // Move lists are only needed to build Clipper clips; leaving them out keeps
    // results small (an infinite's list runs to hundreds of moves).
    const withMoves = req.body?.withMoves === true || req.body?.withMoves === "true";
    const projection = withMoves ? { ...RESULT_FIELDS, moveList: 1 } : RESULT_FIELDS;
    const clips = mongoose.connection.collection("clips");
    const key = { filter: JSON.stringify(filter), sort: JSON.stringify(sort), withMoves };
    const [results, total] = await Promise.all([
      heavyQueries.get(paramsKey("clips", { ...key, page, limit }), () =>
        clips.find(filter, { projection, sort, skip: (page - 1) * limit, limit, maxTimeMS: 8000, ...(hint ? { hint } : {}) }).toArray()
      ),
      heavyQueries
        .get(paramsKey("clipcount", { filter: key.filter }), () => clips.countDocuments(filter, { limit: CLIP_COUNT_CAP, maxTimeMS: 8000, ...(hint ? { hint } : {}) }))
        .catch(() => null), // a slow count shouldn't lose the results
    ]);
    res.json({
      results: results.map(({ _id, ...c }) => ({ id: _id, ...c })),
      total,
      capped: total == null || total >= CLIP_COUNT_CAP,
      page,
      limit,
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
