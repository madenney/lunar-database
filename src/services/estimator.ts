import { Replay } from "../models/Replay";
import { buildReplaySearchQuery, buildSortedQuery, ReplaySearchParams } from "./replaySearchQuery";
import { config } from "../config";

/**
 * Per-file throughput used for ETA estimates (files per second).
 *
 * The slpz cache is now ~fully populated, so bundle building is dominated by
 * COPYING cached .slpz files from the worker (over NFS) into the job temp dir,
 * not by fresh compression. Measured serial cache-hit copy rate over the NFS
 * mount is ~59 files/s (avg .slpz ~359 KB, latency-bound). Rounded down to 50 to
 * absorb the occasional cache miss (fresh compress of a raw .slp ~1/s) and the
 * final archive step. (The old value of 120 assumed fresh compression and never
 * matched the NFS-mounted reality.)
 */
export const COMPRESS_RATE = 50;

export interface EstimateResult {
  count: number;
  rawSize: number;
  estimatedZipSize: number;
  estimatedProcessingTimeSec: number;
}

/**
 * Query MongoDB for replay count + total raw size, respecting maxFiles/maxSizeMb limits.
 */
export async function queryCountAndSize(
  filter: ReplaySearchParams,
  options?: { includeDuration?: boolean }
): Promise<{ count: number; rawSize: number; totalDurationFrames: number }> {
  const query = buildReplaySearchQuery(filter);
  const maxFiles = filter.maxFiles != null && Number(filter.maxFiles) > 0 ? Number(filter.maxFiles) : undefined;
  const maxSizeMb = filter.maxSizeMb != null && Number(filter.maxSizeMb) > 0 ? Number(filter.maxSizeMb) : undefined;
  const wantDuration = !!options?.includeDuration;

  // A byte budget (maxSizeMb) has to be applied per-file in sort order, so stream
  // a sorted cursor and accumulate until the budget is hit. maxSizeMb is capped at
  // 10 GB upstream, so this only ever reads a few thousand docs — bounded memory,
  // no full-collection load.
  if (maxSizeMb != null) {
    const { query: sortedQuery, sortObj } = buildSortedQuery(filter);
    const maxBytes = maxSizeMb * 1024 * 1024;
    const fileCap = maxFiles ?? Infinity;
    let count = 0;
    let rawSize = 0;
    let totalDurationFrames = 0;
    const cursor = Replay.find(sortedQuery)
      .select(wantDuration ? "fileSize duration" : "fileSize")
      .sort(sortObj)
      .maxTimeMS(15000)
      .lean()
      .cursor();
    for await (const doc of cursor) {
      if (count >= fileCap) break;
      const size = (doc as any).fileSize ?? 0;
      // Always include at least one file, then stop before exceeding the budget.
      if (count > 0 && rawSize + size > maxBytes) break;
      count++;
      rawSize += size;
      if (wantDuration) totalDurationFrames += (doc as any).duration ?? 0;
    }
    await cursor.close();
    return { count, rawSize, totalDurationFrames };
  }

  // No byte budget: compute the true totals server-side via aggregation — no doc
  // streaming, no memory cap, works for the whole collection. A maxFiles limit is
  // turned into a proportional estimate off the full average (exact when the limit
  // doesn't actually trim, i.e. maxFiles >= count). This avoids sorting millions of
  // docs just to size a slice; the worker streams the exact first-N when it builds
  // the real bundle.
  const groupFields: any = {
    _id: null,
    totalSize: { $sum: "$fileSize" },
  };
  if (wantDuration) {
    groupFields.totalDuration = { $sum: { $ifNull: ["$duration", 0] } };
  }

  const [totalCount, agg] = await Promise.all([
    Replay.countDocuments(query).maxTimeMS(15000),
    Replay.aggregate([{ $match: query }, { $group: groupFields }]).option({ maxTimeMS: 15000 }),
  ]);

  const totalSize = agg[0]?.totalSize ?? 0;
  const totalDuration = wantDuration ? (agg[0]?.totalDuration ?? 0) : 0;

  // maxFiles >= the match count doesn't trim anything → report the true total.
  const effectiveCount = maxFiles != null ? Math.min(maxFiles, totalCount) : totalCount;
  const ratio = totalCount > 0 ? effectiveCount / totalCount : 0;

  return {
    count: effectiveCount,
    rawSize: maxFiles != null ? Math.round(totalSize * ratio) : totalSize,
    totalDurationFrames: maxFiles != null ? Math.round(totalDuration * ratio) : totalDuration,
  };
}

/**
 * Calculate estimated sizes and processing time from count + rawSize.
 */
export function calculateEstimates(count: number, rawSize: number): EstimateResult {
  const estimatedZipSize = Math.round(rawSize / 8) + count * 128;
  const compressTimeSec = count / COMPRESS_RATE;
  const uploadTimeSec = estimatedZipSize / (config.estimateUploadSpeedMbps * 125000);
  const estimatedProcessingTimeSec = Math.round(compressTimeSec + uploadTimeSec);

  return { count, rawSize, estimatedZipSize, estimatedProcessingTimeSec };
}
