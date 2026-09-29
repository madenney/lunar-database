/**
 * Which recording of a game to show when the archive holds several
 * (scripts/markDuplicates.ts).
 */
import type mongoose from "mongoose";

/** Recordings of one game can differ by a few frames at the end; 2 s of slack. */
export const MAX_SPREAD_FRAMES = 120;

export type Recording = {
  _id: mongoose.Types.ObjectId | string;
  duration: number | null;
  fileSize: number | null;
  setId: string | null;
  tournamentKey?: string | null;
  source?: string | null;
};

/** Safely the same game: every length known and within MAX_SPREAD_FRAMES. */
export function sameGame(recs: Recording[]): boolean {
  if (recs.length < 2 || recs.some((r) => r.duration == null)) return false;
  const d = recs.map((r) => r.duration as number);
  return Math.max(...d) - Math.min(...d) <= MAX_SPREAD_FRAMES;
}

/**
 * The copy to keep visible. A game belongs where it was played: prefer a copy
 * linked to a set, then one grouped into a tournament, then one from a
 * tournament folder, so tournament pages keep their games (a spectator's
 * netplay capture of the same game can be the bigger file). Then the largest
 * file, then the first indexed.
 */
export function pickCanonical<R extends Recording>(recs: R[]): R {
  const rank = (r: R) => (r.setId ? 3 : r.tournamentKey ? 2 : r.source === "tournament" ? 1 : 0);
  return [...recs].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      (b.fileSize ?? 0) - (a.fileSize ?? 0) ||
      String(a._id).localeCompare(String(b._id))
  )[0];
}
