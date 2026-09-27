import mongoose, { Schema, Document } from "mongoose";
import { statsCollection } from "./GameStats";

export const SHARD_STATUSES = ["pending", "running", "committed", "failed"] as const;
export type ShardStatus = (typeof SHARD_STATUSES)[number];

/** A published detail file: one per extractor with events, per shard. */
export interface ShardFile {
  file: string;
  lines: number;
  bytes: number;
  sha256: string;
}

/**
 * One unit of stats-extraction work: the usable replays with IDs in [fromId, toId]
 * for one stats run (see services/statsShards.ts). Any machine may claim a
 * pending shard; a shard is done only once its detail files and summaries are
 * published and the record is committed.
 */
export interface IStatsShard extends Document<string> {
  _id: string;
  run: string;
  fromId: mongoose.Types.ObjectId;
  toId: mongoose.Types.ObjectId;
  /** Usable replays in the range when planned. */
  planned: number;
  /**
   * A retry shard's explicit replays (e.g. games that errored), instead of the
   * [fromId, toId] range. Its detail files are separate from the range shards'.
   */
  replayIds?: mongoose.Types.ObjectId[] | null;
  /** Random claim order, so work (and early results) spreads across the archive. */
  order: number;
  status: ShardStatus;
  owner: string | null;
  leaseUntil: Date | null;
  attempts: number;
  lastError: string | null;
  /** Set on commit. */
  games: number | null;
  failedGames: number | null;
  files: Record<string, ShardFile> | null;
  parser: string | null;
  committedAt: Date | null;
}

const StatsShardSchema = new Schema<IStatsShard>(
  {
    _id: { type: String, required: true },
    run: { type: String, required: true },
    fromId: { type: Schema.Types.ObjectId, required: true },
    toId: { type: Schema.Types.ObjectId, required: true },
    planned: { type: Number, required: true },
    replayIds: { type: [Schema.Types.ObjectId], default: undefined },
    order: { type: Number, required: true },
    status: { type: String, enum: SHARD_STATUSES, default: "pending" },
    owner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    games: { type: Number, default: null },
    failedGames: { type: Number, default: null },
    files: { type: Schema.Types.Mixed, default: null },
    parser: { type: String, default: null },
    committedAt: { type: Date, default: null },
  },
  { collection: statsCollection("statsShards") }
);

StatsShardSchema.index({ run: 1, status: 1, order: 1 });
StatsShardSchema.index({ run: 1, toId: -1 });

export const StatsShard = mongoose.model<IStatsShard>("StatsShard", StatsShardSchema);
