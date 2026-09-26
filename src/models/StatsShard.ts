import mongoose, { Schema, Document } from "mongoose";

export const SHARD_STATUSES = ["pending", "running", "committed", "failed"] as const;
export type ShardStatus = (typeof SHARD_STATUSES)[number];

/**
 * One unit of stats-extraction work: the usable replays with IDs in [fromId, toId]
 * at one STATS_VERSION (see services/statsShards.ts). Any machine may claim a
 * pending shard; a shard is done only once its detail file and summaries are
 * published and the record is committed.
 */
export interface IStatsShard extends Document<string> {
  _id: string;
  version: number;
  fromId: mongoose.Types.ObjectId;
  toId: mongoose.Types.ObjectId;
  /** Usable replays in the range when planned. */
  planned: number;
  status: ShardStatus;
  owner: string | null;
  leaseUntil: Date | null;
  attempts: number;
  lastError: string | null;
  /** Set on commit. */
  games: number | null;
  failedGames: number | null;
  file: string | null;
  bytes: number | null;
  sha256: string | null;
  parser: string | null;
  committedAt: Date | null;
}

const StatsShardSchema = new Schema<IStatsShard>(
  {
    _id: { type: String, required: true },
    version: { type: Number, required: true },
    fromId: { type: Schema.Types.ObjectId, required: true },
    toId: { type: Schema.Types.ObjectId, required: true },
    planned: { type: Number, required: true },
    status: { type: String, enum: SHARD_STATUSES, default: "pending" },
    owner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    games: { type: Number, default: null },
    failedGames: { type: Number, default: null },
    file: { type: String, default: null },
    bytes: { type: Number, default: null },
    sha256: { type: String, default: null },
    parser: { type: String, default: null },
    committedAt: { type: Date, default: null },
  },
  { collection: "statsShards" }
);

StatsShardSchema.index({ version: 1, status: 1, fromId: 1 });
StatsShardSchema.index({ version: 1, toId: -1 });

export const StatsShard = mongoose.model<IStatsShard>("StatsShard", StatsShardSchema);
