import mongoose, { Schema, Document } from "mongoose";
import { config } from "../config";

export interface IDownloadEvent extends Document {
  type: "job" | "replay" | "full_db";
  jobId: mongoose.Types.ObjectId | null;
  replayId: mongoose.Types.ObjectId | null;
  clientId: string | null;
  bundleSize: number | null; // bytes transferred
  replayCount: number | null; // replays in the bundle (job only)
  createdAt: Date;
}

const DownloadEventSchema = new Schema<IDownloadEvent>(
  {
    type: { type: String, enum: ["job", "replay", "full_db"], required: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", default: null },
    replayId: { type: Schema.Types.ObjectId, ref: "Replay", default: null },
    clientId: { type: String, default: null },
    bundleSize: { type: Number, default: null },
    replayCount: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// TTL: expire download events (which hold clientId) after the retention window
// (M3). Floored above the full-DB throttle window + a buffer, because the
// throttle counts full_db rows within config.fullDbWindowHours and must never
// have them expired out from under it. See scripts/addEventTtl.ts to change the
// value on an existing deployment.
DownloadEventSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: Math.max(
      config.analyticsRetentionDays * 24 * 60 * 60,
      (config.fullDbWindowHours + 24) * 60 * 60
    ),
  }
);
DownloadEventSchema.index({ type: 1, createdAt: 1 });
DownloadEventSchema.index({ clientId: 1, createdAt: 1 });

export const DownloadEvent = mongoose.model<IDownloadEvent>("DownloadEvent", DownloadEventSchema);
