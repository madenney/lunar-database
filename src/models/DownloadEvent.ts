import mongoose, { Schema, Document } from "mongoose";

export interface IDownloadEvent extends Document {
  type: "job" | "replay";
  jobId: mongoose.Types.ObjectId | null;
  replayId: mongoose.Types.ObjectId | null;
  clientId: string | null;
  bundleSize: number | null; // bytes transferred
  replayCount: number | null; // replays in the bundle (job only)
  createdAt: Date;
}

const DownloadEventSchema = new Schema<IDownloadEvent>(
  {
    type: { type: String, enum: ["job", "replay"], required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", default: null },
    replayId: { type: Schema.Types.ObjectId, ref: "Replay", default: null },
    clientId: { type: String, default: null },
    bundleSize: { type: Number, default: null },
    replayCount: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

DownloadEventSchema.index({ createdAt: 1 });
DownloadEventSchema.index({ type: 1, createdAt: 1 });
DownloadEventSchema.index({ clientId: 1, createdAt: 1 });

export const DownloadEvent = mongoose.model<IDownloadEvent>("DownloadEvent", DownloadEventSchema);
