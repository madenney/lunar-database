import mongoose from "mongoose";
import { Job } from "../models/Job";

jest.mock("./bundler", () => ({ cleanupJobTemp: jest.fn() }));
import { reapStuckJobs } from "./reapStuckJobs";

beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-reaper`);
});
afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
});
afterEach(async () => {
  await Job.deleteMany({});
});

function makeJob(status: string, ageMinutes: number | null) {
  return Job.create({
    filter: {},
    status,
    createdBy: "c",
    startedAt: ageMinutes == null ? null : new Date(Date.now() - ageMinutes * 60_000),
  });
}

describe("reapStuckJobs (M5)", () => {
  it("fails a job stuck in an active state past the threshold", async () => {
    const job = await makeJob("processing", 120);
    const { reaped } = await reapStuckJobs(60);

    expect(reaped).toBe(1);
    const after = await Job.findById(job._id).lean();
    expect(after!.status).toBe("failed");
    expect(after!.error).toMatch(/reaped/i);
    expect(after!.progress).toBeNull();
  });

  it("times an upload from its own claim, not from when compression started", async () => {
    const job = await Job.create({
      filter: {}, status: "uploading", createdBy: "c",
      startedAt: new Date(Date.now() - 600 * 60_000), // compression began 10h ago
      phaseStartedAt: new Date(Date.now() - 10 * 60_000), // upload claimed 10 min ago
    });
    const { reaped } = await reapStuckJobs(60);
    expect(reaped).toBe(0);
    expect((await Job.findById(job._id).lean())!.status).toBe("uploading");
  });

  it("reaps a phase that has itself run too long", async () => {
    const job = await Job.create({
      filter: {}, status: "uploading", createdBy: "c",
      startedAt: new Date(Date.now() - 600 * 60_000),
      phaseStartedAt: new Date(Date.now() - 120 * 60_000),
    });
    expect((await reapStuckJobs(60)).reaped).toBe(1);
    expect((await Job.findById(job._id).lean())!.status).toBe("failed");
  });

  it("leaves a recently-started active job alone", async () => {
    const job = await makeJob("uploading", 10);
    const { reaped } = await reapStuckJobs(60);

    expect(reaped).toBe(0);
    expect((await Job.findById(job._id).lean())!.status).toBe("uploading");
  });

  it("ignores non-active jobs even if old", async () => {
    const job = await makeJob("completed", 999);
    const { reaped } = await reapStuckJobs(60);

    expect(reaped).toBe(0);
    expect((await Job.findById(job._id).lean())!.status).toBe("completed");
  });

  it("ignores active jobs with no startedAt", async () => {
    const job = await makeJob("processing", null);
    const { reaped } = await reapStuckJobs(60);

    expect(reaped).toBe(0);
    expect((await Job.findById(job._id).lean())!.status).toBe("processing");
  });
});
