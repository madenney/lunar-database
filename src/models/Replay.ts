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
  indexedAt: { type: Date, default: Date.now },
});

ReplaySchema.index({ "players.connectCode": 1 });
ReplaySchema.index({ "players.characterId": 1 });
ReplaySchema.index({ stageId: 1 });
ReplaySchema.index({ startAt: 1 });
ReplaySchema.index({ source: 1 });

export const Replay = mongoose.model<IReplay>("Replay", ReplaySchema);
