import mongoose, { Schema, Document } from "mongoose";
import type { PlayerProfile } from "../services/playerStats";

/**
 * Career stats per connect code (services/playerStats.ts), rebuilt from gameStats
 * by `npm run build-player-stats`. Serves the website's player profile pages.
 */
export interface IPlayerStats extends Document, PlayerProfile {
  builtAt: Date;
}

const PlayerStatsSchema = new Schema<IPlayerStats>(
  {
    connectCode: { type: String, required: true, unique: true },
    names: { type: Schema.Types.Mixed, default: [] },
    userIds: { type: [String], default: [] },
    otherCodes: { type: [String], default: [] },
    games: { type: Number, required: true },
    decided: { type: Number, required: true },
    wins: { type: Number, required: true },
    firstPlayed: { type: Date, default: null },
    lastPlayed: { type: Date, default: null },
    sources: { type: Schema.Types.Mixed, default: {} },
    characters: { type: Schema.Types.Mixed, default: [] },
    stages: { type: Schema.Types.Mixed, default: [] },
    vsCharacters: { type: Schema.Types.Mixed, default: [] },
    opponents: { type: Schema.Types.Mixed, default: [] },
    monthly: { type: Schema.Types.Mixed, default: [] },
    totals: { type: Schema.Types.Mixed, required: true },
    techLedge: { type: Schema.Types.Mixed, default: {} },
    builtAt: { type: Date, required: true },
  },
  { collection: "playerStats" }
);

PlayerStatsSchema.index({ games: -1 });

export const PlayerStats = mongoose.model<IPlayerStats>("PlayerStats", PlayerStatsSchema);
