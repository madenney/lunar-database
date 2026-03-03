import mongoose, { Schema, Document } from "mongoose";

export interface IReplayPlayer {
  playerIndex: number;
  connectCode: string | null;
  displayName: string | null;
  tag: string | null;
  characterId: number | null;
  characterName: string | null;
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
  indexedAt: { type: Date, default: Date.now },
});

ReplaySchema.index({ "players.connectCode": 1 });
ReplaySchema.index({ "players.characterId": 1 });
ReplaySchema.index({ stageId: 1 });
ReplaySchema.index({ startAt: 1 });

export const Replay = mongoose.model<IReplay>("Replay", ReplaySchema);
