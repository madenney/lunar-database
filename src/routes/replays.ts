import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { Replay } from "../models/Replay";
import { GameStats } from "../models/GameStats";
import { Tournament } from "../models/Tournament";
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
import { StreamGate } from "../services/replayStreams";
import { archiveUrl, currentSnapshotId } from "../services/fullDbArchive";
import { isServiceCaller } from "../middleware/serviceCaller";
import mongoose from "mongoose";
import { uplink } from "../services/uplink";
import { queryCountAndSize, calculateEstimates } from "../services/estimator";
import { sanitizeFilters } from "../utils/sanitizeFilters";

const router = Router();

/**
 * Stored replay fields never sent to the public: the server path, and the import
 * folder label, whose collection folders can carry a person's real name. Both stay
 * in the database for bundling and backfills.
 */
const PUBLIC_REPLAY_EXCLUDE = "-filePath -folderLabel -archive";

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
/**
 * Names of the listed tournaments these replays belong to, keyed by
 * tournamentKey, so a row can say where a game came from and link its page.
 * Unlisted tournaments (no public page) are left out.
 */
export async function tournamentNames(replays: { tournamentKey?: string | null }[]): Promise<Map<string, string>> {
  const keys = [...new Set(replays.map((r) => r.tournamentKey).filter((k): k is string => typeof k === "string"))];
  if (!keys.length) return new Map();
  const rows = await Tournament.find({ _id: { $in: keys }, listed: { $ne: false } }).select({ name: 1 }).lean();
  return new Map(rows.map((t) => [String(t._id), t.name]));
}

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
      ...(params.replayIds ? { missing: Math.max(0, params.replayIds.length - count) } : {}),
      /** Counting stopped at the cap: count and sizes are "at least". */
      capped: !!capped,
      rawSize,
      estimatedSlpzSize: Math.round(rawSize / 8),
      estimatedZipSize: estimates.estimatedZipSize,
      estimatedTimeSec: estimates.estimatedProcessingTimeSec,
      totalDurationFrames,
      queue: {
        reusable: reusable ? { jobId: reusable._id, status: reusable.status } : null,
        tooLarge: maxBytes > 0 && estimates.estimatedZipSize > maxBytes,
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
    const { query: finalQuery, sortObj, hint } = await resolveSelection({ ...params, sort: sort as string | undefined });

    const rawPage = parseInt(page as string, 10);
    const rawLimit = parseInt(limit as string, 10);
    const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.min(rawPage, 100000)) : 1;
    // Cap matches the frontend's largest page-size option (1,000). Anything
    // above is clamped so a single response can't blow up.
    const limitNum = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, rawLimit)) : 50;
    const skip = (pageNum - 1) * limitNum;

    const [replays, total] = await Promise.all([
      (hint ? Replay.find(finalQuery).hint(hint) : Replay.find(finalQuery)).select(PUBLIC_REPLAY_EXCLUDE).sort(sortObj).skip(skip).limit(limitNum).maxTimeMS(10000).lean(),
      // Counting a broad filter is the expensive part of a search; reuse it.
      // Exact by default (COUNT_CAP can bound it); cached, so ~1.5 s only the first time.
      heavyQueries.get(paramsKey("count", { ...params, sort }), () =>
        Replay.countDocuments(finalQuery, { ...(config.countCap > 0 ? { limit: config.countCap } : {}), ...(hint ? { hint } : {}) }).maxTimeMS(15000)
      ),
    ]);

    // Extracted stats are an enhancement: a slow or failed lookup never fails the search.
    const stats = await rowStats(replays.map((r) => r._id)).catch(() => new Map<string, Record<string, unknown>>());
    const names = await tournamentNames(replays).catch(() => new Map<string, string>());
    const withStats = replays.map((r) => ({
      ...r,
      stats: stats.get(String(r._id)) ?? null,
      tournamentName: (r.tournamentKey && names.get(r.tournamentKey)) || null,
    }));

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
        totalCapped: config.countCap > 0 && total >= config.countCap,
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
    const names = await tournamentNames([replay]).catch(() => new Map<string, string>());
    res.json({ ...replay, tournamentName: (replay.tournamentKey && names.get(replay.tournamentKey)) || null });
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

const sourceLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many replay requests, please try again later" },
});

// GET /api/replays/:id/source — where to read this replay from storage instead of here.
// For the website only (service key). The replay's bytes are a range of the full-DB zip
// (services/fullDbArchive.ts); answers { source: null } when the replay isn't in the
// current zip, and the website falls back to /download.
router.get("/:id/source", sourceLimiter, async (req: Request, res: Response) => {
  try {
    if (!isServiceCaller(req)) {
      res.status(403).json({ error: "Not available" });
      return;
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    const replay = await Replay.findById(req.params.id).select("archive filePath fileSize").lean();
    if (!replay) {
      res.status(404).json({ error: "Replay not found" });
      return;
    }
    const a = replay.archive;
    const current = a ? await currentSnapshotId() : null;
    if (!a || !current || a.snapshot !== current || !(a.length > 0)) {
      res.json({ source: null });
      return;
    }
    DownloadEvent.create({
      type: "replay",
      replayId: replay._id,
      clientId: (req.headers["x-client-id"] as string) || null,
      bundleSize: replay.fileSize || null,
      replayCount: 1,
    }).catch(() => {});
    res.json({
      source: {
        url: await archiveUrl(600),
        offset: a.offset,
        length: a.length,
        format: a.format,
        filename: path.basename(replay.filePath),
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});

const replayStreams = new StreamGate(config.replayStreamsMax);

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
    const release = await replayStreams.acquire(config.replayStreamWaitMs);
    if (!release) {
      res.setHeader("Retry-After", "5");
      sendApiError(res, 503, "storage_busy", { error: "Replays are busy, please try again shortly" });
      return;
    }
    res.on("close", release);
    if (req.destroyed) return; // the visitor left while waiting; close frees the slot

    // Log download event for analytics
    const clientId = req.headers["x-client-id"] as string | undefined;
    DownloadEvent.create({
      type: "replay",
      replayId: replay._id,
      clientId: clientId || null,
      bundleSize: replay.fileSize || null,
      replayCount: 1,
    }).catch(() => {});

    // A .slp gzips 4-6x for ~80 ms of CPU, and every replay view crosses the server's
    // uplink (~5 MB/s), so compress whenever the caller accepts it (the website's
    // fetch does). Range requests get the plain file.
    if (!req.headers.range && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
      res.attachment(path.basename(resolved));
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      pipeline(fs.createReadStream(resolved), zlib.createGzip({ level: 6 }), uplink.stream(), res).catch(() => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      return;
    }
    res.download(resolved, path.basename(resolved));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
