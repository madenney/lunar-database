import mongoose, { Schema, Document } from "mongoose";
import type { ParsedSet } from "../services/sets";

/**
 * A tournament set: its tournament, round, players and games in order
 * (services/sets.ts, scripts/buildSets.ts). Replays point back via setId/setGame.
 */
export interface ITournamentSet extends Document<string>, Omit<ParsedSet, "_id" | "games"> {
  _id: string;
  tournamentKey: string;
  /** Archive folder of the set's games (internal: folder names can carry real names). */
  dir: string;
  games: { replayId: mongoose.Types.ObjectId | null; n: number; winner: number | null }[];
  builtAt: Date;
}

const TournamentSetSchema = new Schema<ITournamentSet>(
  {
    _id: { type: String, required: true },
    source: { type: String, required: true },
    tournamentKey: { type: String, required: true },
    tournament: { type: Schema.Types.Mixed, required: true },
    event: { type: String, default: null },
    round: { type: String, default: null },
    bestOf: { type: Number, default: null },
    location: { type: String, default: null },
    startgg: { type: Schema.Types.Mixed, default: null },
    players: { type: Schema.Types.Mixed, default: [] },
    winner: { type: Number, default: null },
    games: { type: Schema.Types.Mixed, default: [] },
    startAt: { type: Date, default: null },
    dir: { type: String, required: true },
    builtAt: { type: Date, required: true },
  },
  { collection: "sets" }
);

TournamentSetSchema.index({ tournamentKey: 1, startAt: 1 });

export const TournamentSet = mongoose.model<ITournamentSet>("TournamentSet", TournamentSetSchema);
