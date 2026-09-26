import mongoose, { Schema, Document } from "mongoose";
import type { CoreSummary, ExtractorName, IdentitySummary, TechLedgeCounts } from "../services/gameStats";
import type { PositionStats } from "../vendor/replay-analysis";

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
 * Per-game stats (see services/gameStats.ts and scripts/extractStats.ts): one
 * document per replay, built up by independently versioned extractors. Each
 * extractor $sets only its own fields and records its version in `extractors`,
 * so runs can add or replace one extractor without redoing the rest. Events go to
 * compressed detail files on the archive drive, not here.
 *
 * Writes go through the raw collection (scripts/extractStats.ts), so a field is
 * never dropped for being undeclared; the schema below documents them for reads.
 */
export interface IGameStats extends Document, Partial<CoreSummary>, Partial<IdentitySummary> {
  replayId: mongoose.Types.ObjectId;
  filePath: string;
  source: string | null;
  startAt: Date | null;
  /** Extractor name -> version that produced its fields. */
  extractors: Partial<Record<ExtractorName, number>>;
  /** Extractor name -> sub-detectors that threw (their events are missing, not empty). */
  extractorErrors?: Partial<Record<ExtractorName, string[]>>;
  /** Extractor name -> the stats run and shard that last wrote it. */
  shards: Partial<Record<ExtractorName, string>>;
  position?: PositionStats;
  techLedge?: TechLedgeCounts;
  /** Set when the replay could not be parsed at all. */
  error: string | null;
  extractedAt: Date;
}

const GameStatsSchema = new Schema<IGameStats>(
  {
    replayId: { type: Schema.Types.ObjectId, required: true, unique: true },
    filePath: { type: String, required: true },
    source: { type: String, default: null },
    startAt: { type: Date, default: null },
    extractors: { type: Schema.Types.Mixed, default: {} },
    extractorErrors: { type: Schema.Types.Mixed, default: undefined },
    shards: { type: Schema.Types.Mixed, default: {} },
    error: { type: String, default: null },
    // core
    slpVersion: String,
    playedOn: String,
    consoleNick: String,
    match: { type: Schema.Types.Mixed, default: undefined },
    rules: { type: Schema.Types.Mixed, default: undefined },
    rollbackFrames: Number,
    placements: { type: [Schema.Types.Mixed], default: undefined },
    resultPolicy: Number,
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
    // identity
    contentHash: String,
    fingerprint: String,
    gecko: { type: Schema.Types.Mixed, default: undefined },
    // position, techLedge
    position: { type: Schema.Types.Mixed, default: undefined },
    techLedge: { type: Schema.Types.Mixed, default: undefined },
    extractedAt: { type: Date, required: true },
  },
  { collection: statsCollection("gameStats") }
);

GameStatsSchema.index({ "extractors.core": 1 });
GameStatsSchema.index({ "players.connectCode": 1 });
GameStatsSchema.index({ contentHash: 1 });
GameStatsSchema.index({ fingerprint: 1 });

export const GameStats = mongoose.model<IGameStats>("GameStats", GameStatsSchema);
