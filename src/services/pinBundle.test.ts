import mongoose from "mongoose";
import { Job } from "../models/Job";

const copyMock = jest.fn().mockResolvedValue(undefined);
const deleteMock = jest.fn().mockResolvedValue(undefined);
jest.mock("./storage", () => ({
  copyObject: (...a: any[]) => copyMock(...a),
  deleteFromStorage: (...a: any[]) => deleteMock(...a),
}));

import { pinBundle, unpinBundle } from "./pinBundle";

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-pin`);
});
afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
});
afterEach(async () => {
  await Job.deleteMany({});
  copyMock.mockClear();
  deleteMock.mockClear();
});

function completedJob(r2Key: string, pinned = false) {
  return Job.create({ filter: {}, status: "completed", r2Key, pinned, createdBy: "c" });
}

describe("pinBundle / unpinBundle — copy→save→delete ordering (M2)", () => {
  it("pins: copies to archive/, persists, then deletes the old object", async () => {
    const job = await completedJob("jobs/test.zip");
    await pinBundle(job._id.toString());

    expect(copyMock).toHaveBeenCalledWith("jobs/test.zip", "archive/test.zip");
    // copy happens before delete
    expect(copyMock.mock.invocationCallOrder[0]).toBeLessThan(deleteMock.mock.invocationCallOrder[0]);
    expect(deleteMock).toHaveBeenCalledWith("jobs/test.zip");

    const after = await Job.findById(job._id).lean();
    expect(after!.r2Key).toBe("archive/test.zip");
    expect(after!.pinned).toBe(true);
  });

  it("does NOT strand the bundle if deleting the old object fails", async () => {
    const job = await completedJob("jobs/test.zip");
    deleteMock.mockRejectedValueOnce(new Error("B2 unavailable"));

    await expect(pinBundle(job._id.toString())).resolves.toBeDefined(); // no throw

    const after = await Job.findById(job._id).lean();
    // DB points at the archive/ copy, which exists (copy succeeded) — download works.
    expect(after!.r2Key).toBe("archive/test.zip");
    expect(after!.pinned).toBe(true);
  });

  it("unpins: copies back to jobs/, persists, then deletes the archive object", async () => {
    const job = await completedJob("archive/test.zip", true);
    await unpinBundle(job._id.toString());

    expect(copyMock).toHaveBeenCalledWith("archive/test.zip", "jobs/test.zip");
    expect(deleteMock).toHaveBeenCalledWith("archive/test.zip");

    const after = await Job.findById(job._id).lean();
    expect(after!.r2Key).toBe("jobs/test.zip");
    expect(after!.pinned).toBe(false);
  });

  it("pin is idempotent when already archived (no copy/delete)", async () => {
    const job = await completedJob("archive/test.zip", true);
    await pinBundle(job._id.toString());

    expect(copyMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    const after = await Job.findById(job._id).lean();
    expect(after!.pinned).toBe(true);
    expect(after!.r2Key).toBe("archive/test.zip");
  });
});
