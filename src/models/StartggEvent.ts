import mongoose, { Schema } from "mongoose";

/**
 * An online Melee singles event on start.gg and how far the start.gg sync got
 * with it (scripts/startggSync.ts). Makes the sync resumable: each event is
 * discovered, then checked for archive games between its entrants, then (if it
 * has any) its sets are fetched and matched.
 */
export type StartggEventStatus =
  | "new" // discovered; entrants not fetched yet
  | "no-games" // entrants fetched; no two of them have archive games in the event's window
  | "candidate" // entrants fetched; worth fetching sets
  | "done" // sets fetched and matched
  | "error";

export interface IStartggEvent {
  _id: number;
  tournament: { id: number; name: string; slug: string };
  name: string;
  slug: string;
  startAt: number | null;
  numEntrants: number;
  status: StartggEventStatus;
  /** Entrant id -> connect code, for entrants who linked one on start.gg. */
  codes?: Record<string, string>;
  entrants?: number;
  sets?: { total: number; played: number; bothCodes: number; matched: number };
  error?: string | null;
  checkedAt?: Date;
}

const StartggEventSchema = new Schema<IStartggEvent>(
  {
    _id: { type: Number, required: true },
    tournament: { type: Schema.Types.Mixed, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    startAt: { type: Number, default: null },
    numEntrants: { type: Number, default: 0 },
    status: { type: String, required: true },
    codes: { type: Schema.Types.Mixed },
    entrants: { type: Number },
    sets: { type: Schema.Types.Mixed },
    error: { type: String, default: null },
    checkedAt: { type: Date },
  },
  { collection: "startggEvents" }
);

StartggEventSchema.index({ status: 1, startAt: -1 });

export const StartggEvent = mongoose.model<IStartggEvent>("StartggEvent", StartggEventSchema);
