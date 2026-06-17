import mongoose, { Schema, Document } from "mongoose";

export type JobStatus =
  | "pending"
  | "processing"
  | "bundling"
  | "bundled"
  | "uploading"
  | "completed"
  | "failed"
  | "cancelled";

export interface IJobFilter {
  p1ConnectCode?: string;
  p1CharacterId?: string;
  p1DisplayName?: string;
  p2ConnectCode?: string;
  p2CharacterId?: string;
  p2DisplayName?: string;
  stageId?: string;
  startDate?: string;
  endDate?: string;
  maxFiles?: number;
  maxSizeMb?: number;
  /** "field:dir" sort, so a maxFiles-limited download picks the same first-N the
   *  UI shows in that order. */
  sort?: string;
}

export interface IJobProgress {
  step: string;
  filesProcessed: number;
  filesTotal: number;
  bytesUploaded?: number;
  bytesTotal?: number;
}

export interface IJob extends Document {
  status: JobStatus;
  filter: IJobFilter;
  createdBy: string | null;
  priority: number;
  replayIds: mongoose.Types.ObjectId[];
  replayCount: number;
  /** Total replays matching the filter ignoring maxFiles/maxSizeMb caps.
   *  When > replayCount, the bundle was capped and the user is informed. */
  totalMatched: number | null;
  estimatedSize: number | null;
  estimatedProcessingTime: number | null;
  bundlePath: string | null;
  bundleSize: number | null;
  r2Key: string | null;
  /** When true, the bundle lives under the no-expiry `archive/` prefix and is
   *  exempt from storage cleanup. Toggled by the admin pin/unpin actions. */
  pinned: boolean;
  downloadCount: number;
  lastDownloadedAt: Date | null;
  progress: IJobProgress | null;
  error: string | null;
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

const JobFilterSchema = new Schema<IJobFilter>(
  {
    p1ConnectCode: { type: String },
    p1CharacterId: { type: String },
    p1DisplayName: { type: String },
    p2ConnectCode: { type: String },
    p2CharacterId: { type: String },
    p2DisplayName: { type: String },
    stageId: { type: String },
    startDate: { type: String },
    endDate: { type: String },
    maxFiles: { type: Number },
    maxSizeMb: { type: Number },
    sort: { type: String },
  },
  { _id: false }
);

const JobProgressSchema = new Schema<IJobProgress>(
  {
    step: { type: String },
    filesProcessed: { type: Number, default: 0 },
    filesTotal: { type: Number, default: 0 },
    bytesUploaded: { type: Number },
    bytesTotal: { type: Number },
  },
  { _id: false }
);

const JobSchema = new Schema<IJob>(
  {
    status: {
      type: String,
      enum: ["pending", "processing", "bundling", "bundled", "uploading", "completed", "failed", "cancelled"],
      default: "pending",
    },
    filter: { type: JobFilterSchema, default: {} },
    createdBy: { type: String, default: null },
    priority: { type: Number, default: 0 },
    replayIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Replay" }],
      // No longer populated (kept for backward-compat). Bundles stream straight
      // from the job's filter, so we don't materialise a (potentially
      // multi-million) ID array that would exceed MongoDB's 16MB document limit.
      default: [],
    },
    replayCount: { type: Number, default: 0 },
    totalMatched: { type: Number, default: null },
    estimatedSize: { type: Number, default: null },
    estimatedProcessingTime: { type: Number, default: null },
    bundlePath: { type: String, default: null },
    bundleSize: { type: Number, default: null },
    r2Key: { type: String, default: null },
    pinned: { type: Boolean, default: false },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    progress: { type: JobProgressSchema, default: null },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

JobSchema.index({ status: 1, priority: 1, createdAt: 1 });
JobSchema.index({ createdBy: 1, createdAt: -1 });
JobSchema.index({ status: 1, downloadCount: -1 });
JobSchema.index({ status: 1, r2Key: 1, lastDownloadedAt: 1, completedAt: 1 });

export const Job = mongoose.model<IJob>("Job", JobSchema);
