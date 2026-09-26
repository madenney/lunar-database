import mongoose, { Schema, Document } from "mongoose";
import type { GameStatsSummary } from "../services/gameStats";

/**
 * Collection name for stats data. STATS_NAMESPACE (e.g. "pilot") keeps a trial
 * run's summaries and shards apart from the published collections.
 */
export function statsCollection(base: string): string {
  const ns = process.env.STATS_NAMESPACE?.trim();
  if (ns && !/^[a-z0-9_]+$/i.test(ns)) throw new Error(`Invalid STATS_NAMESPACE: ${ns}`);
  return ns ? `${base}_${ns}` : base;
}

/**
 * Full per-game stats extracted from each replay's frames (see services/gameStats.ts
 * and scripts/extractStats.ts). One document per replay. Per-conversion detail is
 * written to compressed files on the archive drive, not here.
 */
export interface IGameStats extends Document, Partial<GameStatsSummary> {
  replayId: mongoose.Types.ObjectId;
  filePath: string;
  source: string | null;
  startAt: Date | null;
  /** The statsShards record this row was written by; its detail lives in that shard's file. */
  shard: string | null;
  /** Set instead of stats when the replay could not be parsed. */
  error: string | null;
  extractedAt: Date;
}

const GameStatsSchema = new Schema<IGameStats>(
  {
    replayId: { type: Schema.Types.ObjectId, required: true, unique: true },
    filePath: { type: String, required: true },
    source: { type: String, default: null },
    startAt: { type: Date, default: null },
    version: { type: Number, required: true },
    shard: { type: String, default: null },
    error: { type: String, default: null },
    // v2 context (see GameStatsSummary). Every summary field must be declared here:
    // Mongoose drops undeclared fields on write.
    slpVersion: String,
    playedOn: String,
    consoleNick: String,
    match: { type: Schema.Types.Mixed, default: undefined },
    rules: { type: Schema.Types.Mixed, default: undefined },
    rollbackFrames: Number,
    placements: { type: [Schema.Types.Mixed], default: undefined },
    resultPolicy: Number,
    detectorErrors: { type: [String], default: undefined },
    stageId: Number,
    lastFrame: Number,
    gameComplete: Boolean,
    endMethod: Number,
    lrasInitiator: Number,
    isTeams: Boolean,
    numPlayers: Number,
    hasCpu: Boolean,
    winner: Number,
    winMethod: String,
    // Per-player stats, including nested input and action counts.
    players: { type: [Schema.Types.Mixed], default: undefined },
    extractedAt: { type: Date, required: true },
  },
  { collection: statsCollection("gameStats") }
);

GameStatsSchema.index({ version: 1 });
GameStatsSchema.index({ "players.connectCode": 1 });

export const GameStats = mongoose.model<IGameStats>("GameStats", GameStatsSchema);
