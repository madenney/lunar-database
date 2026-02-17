import mongoose, { Schema, Document } from "mongoose";

export type UploadStatus = "uploading" | "extracting" | "done" | "failed";

export interface IUpload extends Document {
  originalFilename: string;
  diskPath: string;
  fileSize: number;
  submittedBy: string | null;
  status: UploadStatus;
  slpCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const UploadSchema = new Schema<IUpload>(
  {
    originalFilename: { type: String, required: true },
    diskPath: { type: String, required: true },
    fileSize: { type: Number, default: 0 },
    submittedBy: { type: String, default: null },
    status: {
      type: String,
      enum: ["uploading", "extracting", "done", "failed"],
      default: "uploading",
    },
    slpCount: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

export const Upload = mongoose.model<IUpload>("Upload", UploadSchema);
