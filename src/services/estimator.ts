import { Replay } from "../models/Replay";
import { buildReplaySearchQuery, buildSortedQuery, ReplaySearchParams } from "./replaySearchQuery";
import { applyReplayLimits } from "../utils/applyReplayLimits";
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
  const maxFiles = filter.maxFiles != null ? Number(filter.maxFiles) : undefined;
  const maxSizeMb = filter.maxSizeMb != null ? Number(filter.maxSizeMb) : undefined;
  const hasLimits = maxFiles != null || maxSizeMb != null;

  if (hasLimits) {
    // Cap the query to avoid loading millions of docs into memory.
    // maxFiles caps the final count; fetch at most that many (or a safe ceiling).
    // Sort first so the limited set is the same first-N the UI shows for this sort.
    const { query: sortedQuery, sortObj } = buildSortedQuery(filter);
    const fetchLimit = Math.min(maxFiles ?? 50000, 50000);
    const selectFields = options?.includeDuration ? "fileSize duration" : "fileSize";
    const docs = await Replay.find(sortedQuery).select(selectFields).sort(sortObj).limit(fetchLimit).maxTimeMS(15000).lean();
    const limited = applyReplayLimits(docs, maxFiles, maxSizeMb);
    return {
      count: limited.length,
      rawSize: limited.reduce((sum, r) => sum + (r.fileSize ?? 0), 0),
      totalDurationFrames: options?.includeDuration
        ? limited.reduce((sum, r) => sum + ((r as any).duration ?? 0), 0)
        : 0,
    };
  }

  const groupFields: any = {
    _id: null,
    totalSize: { $sum: "$fileSize" },
  };
  if (options?.includeDuration) {
    groupFields.totalDuration = { $sum: { $ifNull: ["$duration", 0] } };
  }

  const [count, agg] = await Promise.all([
    Replay.countDocuments(query).maxTimeMS(15000),
    Replay.aggregate([{ $match: query }, { $group: groupFields }]).option({ maxTimeMS: 15000 }),
  ]);

  return {
    count,
    rawSize: agg[0]?.totalSize ?? 0,
    totalDurationFrames: agg[0]?.totalDuration ?? 0,
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
