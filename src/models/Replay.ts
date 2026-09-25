import mongoose, { Schema, Document } from "mongoose";

export interface IReplayPlayer {
  playerIndex: number;
  connectCode: string | null;
  displayName: string | null;
  tag: string | null;
  characterId: number | null;
  characterName: string | null;
}

/** How a replay was produced. Derived from the top-level import folder — see
 *  REPLAY_SOURCES / sourceFromFolderLabel below. */
export type ReplaySource = "netplay" | "ranked" | "tournament";

export const REPLAY_SOURCES: ReplaySource[] = ["netplay", "ranked", "tournament"];

/** Map a folderLabel's top-level directory to a source. The crawler labels every
 *  replay with the directory it came from, and those roots are the source of
 *  truth: `netplay/…`, `ranked_anonymized/…`, `tournament/…`. */
export function sourceFromFolderLabel(folderLabel: string | null | undefined): ReplaySource | null {
  if (!folderLabel) return null;
  const root = folderLabel.split("/")[0];
  if (root === "netplay") return "netplay";
  if (root === "ranked_anonymized") return "ranked";
  if (root === "tournament") return "tournament";
  return null;
}

/**
 * The "not junk" predicate — a replay we're willing to search or serve. It must
 * have a known stage or at least one known character, at least one player, and
 * must not be a zero-length/aborted game. A `duration` of 0 or less means the game
 * ended at or before the "GO!" frame (quit during countdown, handwarmer, truncated
 * file). null/missing duration is KEPT — unknown length, but possibly a valid game.
 *
 * None of this is indexable, so evaluating it forces a fetch of every candidate
 * document. It's materialised onto each doc as `usable` (see isUsableReplay) so
 * queries can hit an index instead. Keep the two in lockstep.
 */
export const NOT_JUNK_QUERY = {
  $or: [{ stageId: { $ne: null } }, { "players.characterId": { $ne: null } }],
  "players.0": { $exists: true },
  duration: { $not: { $lte: 0 } },
};

/** In-process twin of NOT_JUNK_QUERY, for tagging a replay at insert time. */
export function isUsableReplay(r: {
  stageId?: number | null;
  duration?: number | null;
  players?: { characterId?: number | null }[] | null;
}): boolean {
  const players = r.players ?? [];
  if (players.length === 0) return false;
  if (r.stageId == null && !players.some((p) => p.characterId != null)) return false;
  if (r.duration != null && r.duration <= 0) return false; // null duration is kept
  return true;
}

export interface IReplay extends Document {
  filePath: string;
  fileHash: string;
  fileSize: number | null; // bytes
  stageId: number | null;
  stageName: string | null;
  startAt: Date | null;
  duration: number | null; // frames
  players: IReplayPlayer[];
  winner: number | null; // playerIndex of winner, null if inconclusive
  folderLabel: string | null; // loose label derived from folder path
  source: ReplaySource | null; // netplay | ranked | tournament (from folderLabel)
  usable: boolean | null; // materialised NOT_JUNK_QUERY — null = not yet backfilled
  viewCount: number; // times watched in the in-browser viewer (denormalized counter)
  indexedAt: Date;
}

export const PlayerSchema = new Schema<IReplayPlayer>(
  {
    playerIndex: { type: Number, required: true },
    connectCode: { type: String, default: null },
    displayName: { type: String, default: null },
    tag: { type: String, default: null },
    characterId: { type: Number, default: null },
    characterName: { type: String, default: null },
  },
  { _id: false }
);

const ReplaySchema = new Schema<IReplay>({
  filePath: { type: String, required: true, unique: true },
  fileHash: { type: String, required: true },
  fileSize: { type: Number, default: null },
  stageId: { type: Number, default: null },
  stageName: { type: String, default: null },
  startAt: { type: Date, default: null },
  duration: { type: Number, default: null },
  players: { type: [PlayerSchema], default: [] },
  winner: { type: Number, default: null },
  folderLabel: { type: String, default: null },
  source: { type: String, enum: [...REPLAY_SOURCES, null], default: null },
  usable: { type: Boolean, default: null },
  // Times this replay has been watched in the in-browser viewer. Denormalized so
  // the count can be shown per replay (and, later, sorted on — that will need an
  // index; not added yet to avoid a build across the whole collection).
  viewCount: { type: Number, default: 0 },
  indexedAt: { type: Date, default: Date.now },
});

// `usable` is the indexed form of NOT_JUNK_QUERY, and every search filters on it —
// so a replay inserted without it is invisible. Derive it automatically on both
// insert paths (create/save and insertMany) rather than trusting call sites.
// NOTE: bulkWrite bypasses these hooks. That's fine for the existing backfills
// (fileSize/startAt don't affect usability), but anything that writes `duration`,
// `stageId` or `players` must recompute usable — re-running backfillUsable.ts does it.
ReplaySchema.pre("save", function () {
  const doc = this as unknown as IReplay;
  doc.usable = isUsableReplay(doc);
});
// Mongoose 9 passes insertMany middleware only the docs array (no `next`
// callback). The (next, docs) signature from Mongoose 8 threw "next is not a
// function" on every insertMany, which broke the crawler and submission approval.
// (cast: mongoose's pre() overloads don't expose the insertMany docs argument)
ReplaySchema.pre("insertMany", (function (docs: IReplay[]) {
  if (Array.isArray(docs)) {
    for (const doc of docs) doc.usable = isUsableReplay(doc);
  }
}) as never);

ReplaySchema.index({ "players.connectCode": 1 });
ReplaySchema.index({ "players.characterId": 1 });
ReplaySchema.index({ stageId: 1 });
ReplaySchema.index({ startAt: 1 });
ReplaySchema.index({ source: 1 });
// Serves the common estimate/search shape: match on source + usable, then sum
// fileSize/duration straight out of the index. Cuts a 2M-row estimate ~5.7x
// (2.6s -> 0.46s). Name is pinned so it matches the index created by hand.
ReplaySchema.index(
  { source: 1, usable: 1, fileSize: 1, duration: 1 },
  { name: "source_usable_size_dur" }
);

export const Replay = mongoose.model<IReplay>("Replay", ReplaySchema);
