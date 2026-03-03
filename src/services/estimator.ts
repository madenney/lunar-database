import { Replay } from "../models/Replay";
import { buildReplaySearchQuery, ReplaySearchParams } from "./replaySearchQuery";
import { applyReplayLimits } from "../utils/applyReplayLimits";
import { config } from "../config";

/** Compression rate used for ETA estimates (files per second). */
export const COMPRESS_RATE = 120;

export interface EstimateResult {
  count: number;
  rawSize: number;
  estimatedTarSize: number;
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
    const selectFields = options?.includeDuration ? "fileSize duration" : "fileSize";
    const docs = await Replay.find(query).select(selectFields).lean();
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
    Replay.countDocuments(query),
    Replay.aggregate([{ $match: query }, { $group: groupFields }]),
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
  const estimatedTarSize = Math.round(rawSize / 8) + count * 1024;
  const compressTimeSec = count / COMPRESS_RATE;
  const uploadTimeSec = estimatedTarSize / (config.estimateUploadSpeedMbps * 125000);
  const estimatedProcessingTimeSec = Math.round(compressTimeSec + uploadTimeSec);

  return { count, rawSize, estimatedTarSize, estimatedProcessingTimeSec };
}
