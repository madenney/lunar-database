import mongoose from "mongoose";
import path from "path";
import { Job } from "../models/Job";
import { config } from "../config";

// Don't touch B2 or the filesystem.
const uploadMock = jest.fn();
const deleteMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/storage", () => ({
  uploadToStorage: (...a: any[]) => uploadMock(...a),
  deleteFromStorage: (...a: any[]) => deleteMock(...a),
}));
jest.mock("../services/bundler", () => ({ cleanupJobTemp: jest.fn() }));
// Force the cancellation CHECKPOINT to miss, so the test exercises the atomic
// completion guard — i.e. the race window between the checkpoint and the write.
jest.mock("./utils", () => ({ isCancelled: jest.fn().mockResolvedValue(false) }));

import { processNextUpload } from "./uploadWorker";

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-workers`);
});
afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
});
afterEach(async () => {
  await Job.deleteMany({});
  uploadMock.mockReset();
  deleteMock.mockClear();
});

function bundledJob() {
  return Job.create({
    filter: {},
    status: "bundled",
    createdBy: "client-a",
    bundlePath: path.join(config.jobTempDir, "x.zip"),
    bundleSize: 1000,
  });
}

describe("uploadWorker — cancelled-job resurrection race (M1)", () => {
  it("completes normally when no cancel lands", async () => {
    const job = await bundledJob();
    uploadMock.mockResolvedValue(undefined);

    await processNextUpload();

    const after = await Job.findById(job._id).lean();
    expect(after!.status).toBe("completed");
    expect(after!.r2Key).toBe(`jobs/${job._id}.zip`);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("does NOT resurrect a job cancelled mid-upload, and deletes the B2 object", async () => {
    const job = await bundledJob();
    // Simulate a cancel landing during the upload (after the checkpoint).
    uploadMock.mockImplementation(async () => {
      await Job.updateOne({ _id: job._id }, { status: "cancelled" });
    });

    await processNextUpload();

    const after = await Job.findById(job._id).lean();
    expect(after!.status).toBe("cancelled"); // not "completed"
    expect(after!.r2Key ?? null).toBeNull(); // r2Key never set
    expect(deleteMock).toHaveBeenCalledWith(`jobs/${job._id}.zip`);
  });
});
