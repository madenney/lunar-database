import mongoose, { Schema, Document } from "mongoose";

export interface IPlayer extends Document {
  connectCode: string;
  displayName: string | null;
  tag: string | null;
  gameCount: number;
}

const PlayerSchema = new Schema<IPlayer>({
  connectCode: { type: String, required: true, unique: true },
  displayName: { type: String, default: null },
  tag: { type: String, default: null },
  gameCount: { type: Number, default: 0 },
});

PlayerSchema.index({ displayName: 1 });
PlayerSchema.index({ gameCount: -1 });

export const Player = mongoose.model<IPlayer>("Player", PlayerSchema);
