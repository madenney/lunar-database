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
 * A replay that is another recording of a game we already have (duplicateOf,
 * set by scripts/markDuplicates.ts) is not usable either: search, counts,
 * bundles and totals show each game once.
 *
 * None of this is indexable, so evaluating it forces a fetch of every candidate
 * document. It's materialised onto each doc as `usable` (see isUsableReplay) so
 * queries can hit an index instead. Keep the two in lockstep.
 */
export const NOT_JUNK_QUERY = {
  $or: [{ stageId: { $ne: null } }, { "players.characterId": { $ne: null } }],
  "players.0": { $exists: true },
  duration: { $not: { $lte: 0 } },
  duplicateOf: null,
};

/** In-process twin of NOT_JUNK_QUERY, for tagging a replay at insert time. */
export function isUsableReplay(r: {
  stageId?: number | null;
  duration?: number | null;
  players?: { characterId?: number | null }[] | null;
  duplicateOf?: unknown;
}): boolean {
  if (r.duplicateOf) return false;
  const players = r.players ?? [];
  if (players.length === 0) return false;
  if (r.stageId == null && !players.some((p) => p.characterId != null)) return false;
  if (r.duration != null && r.duration <= 0) return false; // null duration is kept
  return true;
}

/**
 * The characters of a 1v1 as a sorted pair ("2-20" = Fox vs Falco), "multi" for
 * 3–4 player games, null when unknown. Indexed, so a matchup search is one index
 * lookup (and its count and size come straight from the index) instead of
 * checking every game of the more common character. Kept by the insert hooks
 * below and the crawler; scripts/backfillCharPair.ts fills older docs.
 */
export function charPairOf(players: { characterId?: number | null }[] | null | undefined): string | null {
  const ps = players ?? [];
  if (ps.length >= 3) return "multi";
  if (ps.length !== 2 || ps.some((p) => p.characterId == null)) return null;
  const [a, b] = ps.map((p) => p.characterId as number).sort((x, y) => x - y);
  return `${a}-${b}`;
}

export interface IReplay extends Document {
  filePath: string;
  fileHash: string;
  fileSize: number | null; // bytes
  stageId: number | null;
  stageName: string | null;
  startAt: Date | null; // null when unknown or the recorded date is impossible
  startAtRaw: Date | null; // the impossible recorded date, kept for reference
  duration: number | null; // frames
  players: IReplayPlayer[];
  winner: number | null; // playerIndex of winner, null if inconclusive
  // Online match context (Slippi 3.14+), written by the crawl; null when absent.
  matchId: string | null; // set/session ID shared by every game of a set
  gameNumber: number | null;
  tiebreaker: number | null;
  mode: string | null; // "ranked" | "unranked" | "direct" | "teams"…
  // Tournament grouping (scripts/buildSets.ts, buildTournaments.ts); null outside tournaments.
  tournamentKey: string | null;
  setId: string | null;
  setGame: number | null;
  /** Another recording of this same game is the one we show (scripts/markDuplicates.ts). */
  duplicateOf: mongoose.Types.ObjectId | null;
  /** See charPairOf. */
  charPair: string | null;
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
  startAtRaw: { type: Date, default: null },
  duration: { type: Number, default: null },
  players: { type: [PlayerSchema], default: [] },
  winner: { type: Number, default: null },
  matchId: { type: String, default: null },
  gameNumber: { type: Number, default: null },
  tiebreaker: { type: Number, default: null },
  mode: { type: String, default: null },
  tournamentKey: { type: String, default: null },
  setId: { type: String, default: null },
  setGame: { type: Number, default: null },
  duplicateOf: { type: Schema.Types.ObjectId, default: null },
  charPair: { type: String, default: null },
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
  doc.charPair = charPairOf(doc.players);
});
// Mongoose 9 passes insertMany middleware only the docs array (no `next`
// callback). The (next, docs) signature from Mongoose 8 threw "next is not a
// function" on every insertMany, which broke the crawler and submission approval.
// (cast: mongoose's pre() overloads don't expose the insertMany docs argument)
ReplaySchema.pre("insertMany", (function (docs: IReplay[]) {
  if (Array.isArray(docs)) {
    for (const doc of docs) {
      doc.usable = isUsableReplay(doc);
      doc.charPair = charPairOf(doc.players);
    }
  }
}) as never);

ReplaySchema.index({ "players.connectCode": 1 });
ReplaySchema.index({ "players.characterId": 1 });
ReplaySchema.index({ stageId: 1 });
ReplaySchema.index({ startAt: 1 });
ReplaySchema.index({ source: 1 });
// Groups the games of an online set. Partial: only replays that carry a match ID
// are indexed, so older files cost nothing.
ReplaySchema.index({ matchId: 1, gameNumber: 1 }, { partialFilterExpression: { matchId: { $type: "string" } } });
ReplaySchema.index({ tournamentKey: 1, startAt: -1 }, { partialFilterExpression: { tournamentKey: { $type: "string" } } });
ReplaySchema.index({ setId: 1 }, { partialFilterExpression: { setId: { $type: "string" } } });
ReplaySchema.index({ duplicateOf: 1 }, { partialFilterExpression: { duplicateOf: { $type: "objectId" } } });
// Source-filtered searches sorted by date. Without it, "ranked only" (all undated)
// walked the startAt index past ~3M dated games first: 5–8 s per search in the
// launch load test.
ReplaySchema.index({ source: 1, usable: 1, startAt: -1 }, { name: "source_usable_startAt" });
// Matchup searches (charPairOf): count and size summed from the index alone.
ReplaySchema.index({ charPair: 1, usable: 1, fileSize: 1, duration: 1 }, { name: "charPair_usable_size_dur" });
// Serves the common estimate/search shape: match on source + usable, then sum
// fileSize/duration straight out of the index. Cuts a 2M-row estimate ~5.7x
// (2.6s -> 0.46s). Name is pinned so it matches the index created by hand.
ReplaySchema.index(
  { source: 1, usable: 1, fileSize: 1, duration: 1 },
  { name: "source_usable_size_dur" }
);

export const Replay = mongoose.model<IReplay>("Replay", ReplaySchema);
