/**
 * Which recording of a game to show when the archive holds several
 * (scripts/markDuplicates.ts).
 */
import type mongoose from "mongoose";

/** Recordings of one game can differ by a few frames at the end; 2 s of slack. */
export const MAX_SPREAD_FRAMES = 120;

export type Recording = { _id: mongoose.Types.ObjectId | string; duration: number | null; fileSize: number | null; setId: string | null };

/** Safely the same game: every length known and within MAX_SPREAD_FRAMES. */
export function sameGame(recs: Recording[]): boolean {
  if (recs.length < 2 || recs.some((r) => r.duration == null)) return false;
  const d = recs.map((r) => r.duration as number);
  return Math.max(...d) - Math.min(...d) <= MAX_SPREAD_FRAMES;
}

/** The copy to keep visible: one linked to a set, else the largest file, else the first indexed. */
export function pickCanonical<R extends Recording>(recs: R[]): R {
  return [...recs].sort(
    (a, b) =>
      Number(!!b.setId) - Number(!!a.setId) ||
      (b.fileSize ?? 0) - (a.fileSize ?? 0) ||
      String(a._id).localeCompare(String(b._id))
  )[0];
}
