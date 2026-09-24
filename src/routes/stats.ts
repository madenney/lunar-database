import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { Job } from "../models/Job";
import { sendError } from "../utils/sendError";
import { createRateLimiter } from "../utils/rateLimiter";

const router = Router();

const statsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many stats requests, please try again later" },
});

type ReplayTotals = {
  replays: number;
  dbSizeBytes: number;
  totalFileSizeBytes: number;
  totalDurationFrames: number;
  replaysWithDuration: number;
};

// Replay totals scan the whole collection, and this route is public, so compute
// them at most once a minute and share an in-flight computation between callers.
// Job counts are cheap and drive live queue positions, so they stay uncached.
const TOTALS_TTL_MS = 60 * 1000;
let totalsCache: { at: number; value: Promise<ReplayTotals> } | null = null;

/** Drop the cached totals (tests, and after bulk imports if needed). */
export function clearStatsCache(): void {
  totalsCache = null;
}

async function computeTotals(): Promise<ReplayTotals> {
  // Exclude junk replays via the materialised `usable` flag (see Replay.ts /
  // backfillUsable.ts) — the raw predicate isn't indexable and forces a fetch of
  // every candidate document.
  const notJunk = { usable: true };
  const [replayCount, dbStats, totalSizeAgg] = await Promise.all([
    Replay.countDocuments(notJunk),
    mongoose.connection.db!.stats(),
    Replay.aggregate([
      { $match: notJunk },
      { $group: {
        _id: null,
        totalSize: { $sum: "$fileSize" },
        totalDurationFrames: { $sum: "$duration" },
        replaysWithDuration: { $sum: { $cond: [{ $gt: ["$duration", 0] }, 1, 0] } },
      } },
    ]),
  ]);
  return {
    replays: replayCount,
    dbSizeBytes: dbStats.dataSize,
    totalFileSizeBytes: totalSizeAgg[0]?.totalSize ?? 0,
    totalDurationFrames: totalSizeAgg[0]?.totalDurationFrames ?? 0,
    replaysWithDuration: totalSizeAgg[0]?.replaysWithDuration ?? 0,
  };
}

function replayTotals(): Promise<ReplayTotals> {
  if (totalsCache && Date.now() - totalsCache.at < TOTALS_TTL_MS) return totalsCache.value;
  const value = computeTotals();
  totalsCache = { at: Date.now(), value };
  // A failed computation must not be served from the cache.
  value.catch(() => {
    if (totalsCache?.value === value) totalsCache = null;
  });
  return value;
}

// GET /api/stats — overview stats
router.get("/", statsLimiter, async (_req: Request, res: Response) => {
  try {
    const [totals, jobCounts] = await Promise.all([
      replayTotals(),
      Job.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const jobs: Record<string, number> = {};
    for (const entry of jobCounts) {
      jobs[entry._id] = entry.count;
    }

    res.json({
      replays: totals.replays,
      jobs,
      dbSizeBytes: totals.dbSizeBytes,
      totalFileSizeBytes: totals.totalFileSizeBytes,
      totalDurationFrames: totals.totalDurationFrames,
      replaysWithDuration: totals.replaysWithDuration,
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
