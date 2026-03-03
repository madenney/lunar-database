import mongoose, { Schema, Document } from "mongoose";
import { IReplayPlayer, PlayerSchema } from "./Replay";

export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface ISubmission extends Document {
  uploadId: mongoose.Types.ObjectId | null;
  originalFilename: string;
  airlockPath: string; // where the file sits in the airlock
  submittedBy: string | null; // optional: who uploaded it
  status: SubmissionStatus;
  stageId: number | null;
  stageName: string | null;
  startAt: Date | null;
  duration: number | null;
  players: IReplayPlayer[];
  winner: number | null;
  replayId: mongoose.Types.ObjectId | null; // set after approval
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SubmissionSchema = new Schema<ISubmission>(
  {
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", default: null },
    originalFilename: { type: String, required: true },
    airlockPath: { type: String, required: true },
    submittedBy: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    stageId: { type: Number, default: null },
    stageName: { type: String, default: null },
    startAt: { type: Date, default: null },
    duration: { type: Number, default: null },
    players: { type: [PlayerSchema], default: [] },
    winner: { type: Number, default: null },
    replayId: { type: Schema.Types.ObjectId, ref: "Replay", default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SubmissionSchema.index({ status: 1, createdAt: 1 });
SubmissionSchema.index({ uploadId: 1, status: 1 });

export const Submission = mongoose.model<ISubmission>("Submission", SubmissionSchema);
