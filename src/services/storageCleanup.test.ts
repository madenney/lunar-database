import mongoose from "mongoose";
import { Job } from "../models/Job";
import { cleanupExpiredJobs } from "./storageCleanup";

const deleteMock = jest.fn().mockResolvedValue(undefined);
jest.mock("./storage", () => ({ deleteFromStorage: (...a: any[]) => deleteMock(...a) }));

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-cleanup`);
});
afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
});
afterEach(async () => {
  await Job.deleteMany({});
  deleteMock.mockClear();
});

function expiredJob(overrides: Record<string, any> = {}) {
  return Job.create({
    filter: {},
    createdBy: "c",
    status: "completed",
    r2Key: "jobs/x.zip",
    bundleSize: 100,
    completedAt: new Date(Date.now() - 10 * DAY),
    ...overrides,
  });
}

describe("cleanupExpiredJobs (L4 batching)", () => {
  it("nulls r2Key on expired completed jobs and sums freed bytes", async () => {
    await expiredJob({ bundleSize: 100 });
    await expiredJob({ bundleSize: 250 });

    const res = await cleanupExpiredJobs(3);
    expect(res.cleaned).toBe(2);
    expect(res.freedBytes).toBe(350);
    expect(await Job.countDocuments({ r2Key: { $ne: null } })).toBe(0);
  });

  it("leaves pinned and not-yet-expired bundles alone", async () => {
    const pinned = await expiredJob({ pinned: true, r2Key: "archive/x.zip" });
    const fresh = await expiredJob({ completedAt: new Date() });

    const res = await cleanupExpiredJobs(3);
    expect(res.cleaned).toBe(0);
    expect((await Job.findById(pinned._id).lean())!.r2Key).toBe("archive/x.zip");
    expect((await Job.findById(fresh._id).lean())!.r2Key).toBe("jobs/x.zip");
  });

  it("drains a backlog larger than one batch (bounded memory)", async () => {
    for (let i = 0; i < 5; i++) await expiredJob();

    const res = await cleanupExpiredJobs(3, false, 2); // batchSize 2 → 3 passes
    expect(res.cleaned).toBe(5);
    expect(await Job.countDocuments({ r2Key: { $ne: null } })).toBe(0);
  });

  it("dry run reports scope without mutating", async () => {
    await expiredJob({ bundleSize: 100 });
    await expiredJob({ bundleSize: 100 });

    const res = await cleanupExpiredJobs(3, true);
    expect(res.cleaned).toBe(2);
    expect(res.freedBytes).toBe(200);
    // nothing nulled
    expect(await Job.countDocuments({ r2Key: { $ne: null } })).toBe(2);
  });
});

describe("cleanupExpiredJobs storage deletion", () => {
  it("deletes an expired bundle's storage object and forgets its key", async () => {
    const job = await expiredJob({ r2Key: "jobs/old.zip" });
    await cleanupExpiredJobs(3);
    expect(deleteMock).toHaveBeenCalledWith("jobs/old.zip");
    expect((await Job.findById(job._id).lean())!.r2Key).toBeNull();
  });

  it("still expires the job when the storage delete fails", async () => {
    deleteMock.mockRejectedValueOnce(new Error("network"));
    const job = await expiredJob({ r2Key: "jobs/flaky.zip" });
    await cleanupExpiredJobs(3);
    expect((await Job.findById(job._id).lean())!.r2Key).toBeNull();
  });

  it("never deletes pinned archive bundles", async () => {
    await expiredJob({ r2Key: "archive/keep.zip", pinned: true });
    await cleanupExpiredJobs(3);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
