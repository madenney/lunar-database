import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Replay } from "../models/Replay";
import { GameStats } from "../models/GameStats";
import { loadGameEvents } from "../services/gameDetail";
import { resolveSelection, ReplaySearchParams } from "../services/replaySearchQuery";
import { filterKey, findReusableJob, forecastNewJob, getQueueState, pauseMessage } from "../services/jobQueue";
import { heavyQueries, paramsKey } from "../services/queryCache";
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

/**
 * Stored replay fields never sent to the public: the server path, and the import
 * folder label, whose collection folders can carry a person's real name. Both stay
 * in the database for bundling and backfills.
 */
const PUBLIC_REPLAY_EXCLUDE = "-filePath -folderLabel";

/** Per-player fields of the compact stats attached to search results. */
const ROW_PLAYER_FIELDS = [
  "playerIndex",
  "characterColor",
  "startStocks",
  "stocksLost",
  "kills",
  "openings",
  "damageDealt",
  "neutralWins",
  "inputsPerMinute",
] as const;

/**
 * Compact extracted stats for a page of results, keyed by replay ID: the result
 * and a few headline numbers per player. Replays not yet extracted are absent.
 */
async function rowStats(ids: unknown[]): Promise<Map<string, Record<string, unknown>>> {
  // (`error` is also a Document method name, so the filter is typed loosely.)
  const filter: Record<string, unknown> = { replayId: { $in: ids }, "extractors.core": { $exists: true }, error: null };
  const docs = await GameStats.find(filter)
    .select({ replayId: 1, winner: 1, winMethod: 1, endMethod: 1, lastFrame: 1, gameComplete: 1, players: 1 })
    .maxTimeMS(5000)
    .lean();
  const out = new Map<string, Record<string, unknown>>();
  for (const d of docs) {
    out.set(String(d.replayId), {
      winner: d.winner ?? null,
      winMethod: d.winMethod ?? null,
      endMethod: d.endMethod ?? null,
      lastFrame: d.lastFrame ?? null,
      gameComplete: d.gameComplete ?? null,
      players: (d.players ?? []).map((p) =>
        Object.fromEntries(ROW_PLAYER_FIELDS.map((k) => [k, (p as unknown as Record<string, unknown>)[k] ?? null]))
      ),
    });
  }
  return out;
}

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

    const { count, rawSize, totalDurationFrames, capped } = await queryCountAndSize(params, { includeDuration: true });
    const estimates = calculateEstimates(count, rawSize);

    // What happens if they click download now: an identical bundle to share, too
    // big for one bundle, or a forecast of when theirs would be ready.
    const [reusable, forecast, state] = await Promise.all([
      findReusableJob(filterKey(params as Record<string, unknown>)),
      forecastNewJob(estimates.estimatedZipSize),
      getQueueState(),
    ]);
    const maxBytes = config.jobMaxBundleMb * 1024 * 1024;

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
      /** Counting stopped at the cap: count and sizes are "at least". */
      capped: !!capped,
      rawSize,
      estimatedSlpzSize: Math.round(rawSize / 8),
      estimatedZipSize: estimates.estimatedZipSize,
      estimatedTimeSec: estimates.estimatedProcessingTimeSec,
      totalDurationFrames,
      queue: {
        reusable: reusable ? { jobId: reusable._id, status: reusable.status } : null,
        tooLarge: estimates.estimatedZipSize > maxBytes,
        maxBytes,
        lane: forecast.lane,
        ahead: forecast.ahead,
        startSec: forecast.startSec,
        readySec: forecast.readySec,
        paused: pauseMessage(state),
      },
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
      tournament: req.query.tournament as string | undefined,
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
      Replay.find(finalQuery).select(PUBLIC_REPLAY_EXCLUDE).sort(sortObj).skip(skip).limit(limitNum).maxTimeMS(10000).lean(),
      // Counting a broad filter is the expensive part of a search; reuse it.
      // It stops at countCap ("150,000+"): an exact count of 1.5M games costs ~1.7 s.
      heavyQueries.get(paramsKey("count", { ...params, sort }), () => Replay.countDocuments(finalQuery, { limit: config.countCap }).maxTimeMS(10000)),
    ]);

    // Extracted stats are an enhancement: a slow or failed lookup never fails the search.
    const stats = await rowStats(replays.map((r) => r._id)).catch(() => new Map<string, Record<string, unknown>>());
    const withStats = replays.map((r) => ({ ...r, stats: stats.get(String(r._id)) ?? null }));

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
      replays: withStats,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
        /** The count stopped at countCap: there are at least `total` matches. */
        totalCapped: total >= config.countCap,
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
    const replay = await Replay.findById(req.params.id).select(PUBLIC_REPLAY_EXCLUDE).lean();
    if (!replay) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    res.json(replay);
  } catch (err) {
    sendError(res, err);
  }
});

const statsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests, please try again later" },
});

// GET /api/replays/:id/stats — everything extracted for one game: the summary
// (context, result, per-player stats, position, tech/ledge counts) and its events
// (conversions, deaths, combos, edgeguards, phantoms, quit-outs, tech/ledge options).
router.get("/:id/stats", statsLimiter, async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!/^[0-9a-f]{24}$/i.test(id)) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    const stats = await GameStats.findOne({ replayId: id })
      .select({ filePath: 0, _id: 0, __v: 0, contentHash: 0 })
      .lean();
    if (!stats || stats.error) {
      res.status(404).json({ error: "No stats for this replay yet" });
      return;
    }
    const events = loadGameEvents(stats);
    // Slippi user IDs link a player's connect codes and console nicknames can be
    // personal; neither is shown publicly (see the players route).
    const { shards: _shards, extractorErrors, consoleNick: _nick, ...summary } = stats;
    summary.players = summary.players?.map(({ userId: _uid, ...p }) => p) as typeof summary.players;
    res.json({ summary, events, extractorErrors: extractorErrors ?? {} });
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
