import mongoose, { Schema, Document } from "mongoose";

export type JobStatus =
  | "pending"
  | "processing"
  | "compressing"
  | "uploading"
  | "completed"
  | "failed"
  | "expired";

export interface IJobFilter {
  connectCode?: string;
  characterId?: number;
  stageId?: number;
  startDate?: Date;
  endDate?: Date;
}

export interface IJobProgress {
  step: string;
  filesProcessed: number;
  filesTotal: number;
}

export interface IJob extends Document {
  status: JobStatus;
  filter: IJobFilter;
  replayIds: mongoose.Types.ObjectId[];
  replayCount: number;
  estimatedSize: number | null;
  bundlePath: string | null;
  bundleSize: number | null;
  downloadUrl: string | null;
  r2Key: string | null;
  expiresAt: Date | null;
  progress: IJobProgress | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

const JobFilterSchema = new Schema<IJobFilter>(
  {
    connectCode: { type: String },
    characterId: { type: Number },
    stageId: { type: Number },
    startDate: { type: Date },
    endDate: { type: Date },
  },
  { _id: false }
);

const JobProgressSchema = new Schema<IJobProgress>(
  {
    step: { type: String },
    filesProcessed: { type: Number, default: 0 },
    filesTotal: { type: Number, default: 0 },
  },
  { _id: false }
);

const JobSchema = new Schema<IJob>(
  {
    status: {
      type: String,
      enum: ["pending", "processing", "compressing", "uploading", "completed", "failed", "expired"],
      default: "pending",
    },
    filter: { type: JobFilterSchema, default: {} },
    replayIds: [{ type: Schema.Types.ObjectId, ref: "Replay" }],
    replayCount: { type: Number, default: 0 },
    estimatedSize: { type: Number, default: null },
    bundlePath: { type: String, default: null },
    bundleSize: { type: Number, default: null },
    downloadUrl: { type: String, default: null },
    r2Key: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    progress: { type: JobProgressSchema, default: null },
    error: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

JobSchema.index({ status: 1, createdAt: 1 });

export const Job = mongoose.model<IJob>("Job", JobSchema);
