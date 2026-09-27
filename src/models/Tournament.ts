import mongoose, { Schema, Document } from "mongoose";

/**
 * One tournament's summary for its page (scripts/buildTournaments.ts): name, dates,
 * size, characters and stages played, and published player names.
 */
export interface ITournament extends Document<string> {
  _id: string; // key, e.g. "midlane-melee-177"
  name: string;
  listed: boolean;
  startggSlug: string | null;
  location: string | null;
  firstAt: Date | null;
  lastAt: Date | null;
  games: number;
  sets: number;
  /** Most frequent player names in the event's replays/sets, with game counts. */
  players: { name: string; games: number }[];
  characters: { characterId: number; games: number }[];
  stages: { stageId: number; games: number }[];
  builtAt: Date;
}

const TournamentSchema = new Schema<ITournament>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    listed: { type: Boolean, default: true },
    startggSlug: { type: String, default: null },
    location: { type: String, default: null },
    firstAt: { type: Date, default: null },
    lastAt: { type: Date, default: null },
    games: { type: Number, required: true },
    sets: { type: Number, default: 0 },
    players: { type: Schema.Types.Mixed, default: [] },
    characters: { type: Schema.Types.Mixed, default: [] },
    stages: { type: Schema.Types.Mixed, default: [] },
    builtAt: { type: Date, required: true },
  },
  { collection: "tournaments" }
);

TournamentSchema.index({ listed: 1, lastAt: -1 });
TournamentSchema.index({ name: "text" });

export const Tournament = mongoose.model<ITournament>("Tournament", TournamentSchema);
