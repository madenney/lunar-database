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
import { REPLAY_SOURCES } from "../models/Replay";
import { sendApiError } from "../utils/apiErrors";

const router = Router();

const clipsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many clip searches, please try again later" },
});

export const CLIP_TYPES = ["combo", "edgeguard", "quitout"] as const;
export const CLIP_COUNT_CAP = 10_000;
const MAX_VALUES = 20;
const MAX_LIMIT = 100;
const MAX_PAGE = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9]{1,8}#\d{1,4}$/;

export interface ClipSearch {
  type: (typeof CLIP_TYPES)[number];
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  page: number;
  limit: number;
}

function list(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" || typeof v === "number" ? String(v).split(",") : [];
  return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_VALUES);
}
const ints = (v: unknown) => [...new Set(list(v).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 1000))];
const codes = (v: unknown) => [...new Set(list(v).map((c) => c.toUpperCase()).filter((c) => CODE_RE.test(c)))];
const oneOrIn = <T>(xs: T[]) => (xs.length === 1 ? xs[0] : { $in: xs });
const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Validate a search body into a MongoDB filter and sort, or return an error message. */
export function parseClipSearch(body: Record<string, unknown>): ClipSearch | { error: string } {
  const type = body.type;
  if (typeof type !== "string" || !(CLIP_TYPES as readonly string[]).includes(type)) {
    return { error: `type must be one of ${CLIP_TYPES.join(", ")}` };
  }
  const filter: Record<string, unknown> = { type };
  const attChars = ints(body.attackerCharacterId);
  const vicChars = ints(body.victimCharacterId);
  const attCodes = codes(body.attackerConnectCode);
  const vicCodes = codes(body.victimConnectCode);
  if (attChars.length) filter["attacker.characterId"] = oneOrIn(attChars);
  if (vicChars.length) filter["victim.characterId"] = oneOrIn(vicChars);
  if (attCodes.length) filter["attacker.connectCode"] = oneOrIn(attCodes);
  if (vicCodes.length) filter["victim.connectCode"] = oneOrIn(vicCodes);

  const stages = ints(body.stageId);
  if (stages.length) filter.stageId = oneOrIn(stages);
  const sources = list(body.source).filter((s) => (REPLAY_SOURCES as readonly string[]).includes(s));
  if (sources.length && sources.length < REPLAY_SOURCES.length) filter.source = oneOrIn(sources);

  const startAt: Record<string, Date> = {};
  if (typeof body.startDate === "string" && DATE_RE.test(body.startDate)) startAt.$gte = new Date(`${body.startDate}T00:00:00Z`);
  if (typeof body.endDate === "string" && DATE_RE.test(body.endDate)) startAt.$lt = new Date(new Date(`${body.endDate}T00:00:00Z`).getTime() + 86_400_000);
  if (Object.keys(startAt).length) filter.startAt = startAt;

  const minDamage = num(body.minDamage);
  if (minDamage != null && minDamage > 0 && type !== "edgeguard") filter.damage = { $gte: minDamage };
  const minMoves = num(body.minMoves);
  if (minMoves != null && minMoves > 0) filter.moves = { $gte: Math.floor(minMoves) };
  if (body.zeroToDeath === true || body.zeroToDeath === "true") {
    if (type === "combo") Object.assign(filter, { didKill: true, startPercent: 0 });
  } else if ((body.killOnly === true || body.killOnly === "true") && type === "combo") {
    filter.didKill = true;
  }

  // Hidden unless asked for: wobbles and one-move infinites (services/clips.ts isInfinite).
  if (!(body.includeInfinites === true || body.includeInfinites === "true")) filter.infinite = { $ne: true };

  // Newest first by default (user decision 2026-09-30); "best" = most damage / best score.
  const sortName = body.sort === "best" || body.sort === "oldest" ? body.sort : "newest";
  const sort: Record<string, 1 | -1> = sortName === "best" ? { rank: -1 } : { startAt: sortName === "newest" ? -1 : 1 };
  // Oldest-first would otherwise open with every undated (ranked) clip.
  if (sortName === "oldest") filter.startAt = { ...(filter.startAt as object), $ne: null };

  const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(num(body.page) ?? 1)));
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(num(body.limit) ?? 25)));
  return { type: type as ClipSearch["type"], filter, sort, page, limit };
}

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
    // Move lists are only needed to build Clipper clips; leaving them out keeps
    // results small (an infinite's list runs to hundreds of moves).
    const withMoves = req.body?.withMoves === true || req.body?.withMoves === "true";
    const projection = withMoves ? { ...RESULT_FIELDS, moveList: 1 } : RESULT_FIELDS;
    const clips = mongoose.connection.collection("clips");
    const key = { filter: JSON.stringify(filter), sort: JSON.stringify(sort), withMoves };
    const [results, total] = await Promise.all([
      heavyQueries.get(paramsKey("clips", { ...key, page, limit }), () =>
        clips.find(filter, { projection, sort, skip: (page - 1) * limit, limit, maxTimeMS: 8000 }).toArray()
      ),
      heavyQueries
        .get(paramsKey("clipcount", { filter: key.filter }), () => clips.countDocuments(filter, { limit: CLIP_COUNT_CAP, maxTimeMS: 8000 }))
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
