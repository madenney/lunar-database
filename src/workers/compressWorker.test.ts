import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import mongoose from "mongoose";
import { Job } from "../models/Job";
import { Replay } from "../models/Replay";
import { config } from "../config";

// Storage is mocked: the "upload" collects the streamed bytes so the test can
// check the finished archive. Everything else (query, bundler, zip writer) is real.
let uploaded: Buffer | null = null;
let failUpload: Error | null = null;
const deleteMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/storage", () => ({
  uploadStream: (body: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      body.on("data", (c: Buffer) => {
        chunks.push(c);
        if (failUpload) reject(failUpload);
      });
      body.on("end", () => ((uploaded = Buffer.concat(chunks)), resolve()));
      body.on("error", reject);
    });
    return { done: () => done, abort: jest.fn().mockResolvedValue(undefined) };
  },
  deleteFromStorage: (...a: any[]) => deleteMock(...a),
  classifyStorageError: jest.requireActual("../services/storage").classifyStorageError,
}));
jest.mock("../services/mailer", () => ({ sendAlertEmail: jest.fn().mockResolvedValue(undefined) }));

import { processNextCompression } from "./compressWorker";

let root: string;
beforeAll(async () => {
  await mongoose.connect(`${process.env.TEST_MONGODB_URL ?? "mongodb://localhost:27017"}/lm-database-test-compress`);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lm-archive-"));
  (config as any).slpRootDir = root;
  (config as any).slpzArchiveDir = root; // .slpz next to each .slp = cache hits, no slpz binary needed
  (config as any).jobTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-temp-"));
});
afterAll(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  await Job.deleteMany({});
  await Replay.deleteMany({});
  uploaded = null;
  failUpload = null;
});

async function seed(n: number) {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(root, `g${i}.slp`), Buffer.alloc(1000, i));
    fs.writeFileSync(path.join(root, `g${i}.slpz`), Buffer.alloc(300 + i, i + 1));
    await Replay.create({ filePath: `g${i}.slp`, fileHash: `h${i}`, fileSize: 1000, stageId: 31, players: [{ playerIndex: 0, connectCode: "S#1", characterId: 2 }] });
  }
}

describe("compressWorker streaming bundles", () => {
  it("streams the bundle to storage and completes the job, with no zip on local disk", async () => {
    await seed(3);
    const job = await Job.create({ filter: { p1ConnectCode: "S#1" }, createdBy: "c", estimatedSize: 3000, replayCount: 3 });
    await processNextCompression();
    const after = (await Job.findById(job._id).lean())!;
    expect(after).toMatchObject({ status: "completed", r2Key: `jobs/${job._id}.zip`, replayCount: 3 });
    expect(after.deadlineAt).toBeTruthy();
    expect(after.bundleSize).toBe(uploaded!.length);
    expect(fs.readdirSync(config.jobTempDir)).toEqual([]);
    const zipPath = path.join(os.tmpdir(), `${job._id}.zip`);
    fs.writeFileSync(zipPath, uploaded!);
    const names = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(' '.join(sorted(z.namelist())))", zipPath]).toString().trim();
    fs.unlinkSync(zipPath);
    expect(names).toBe("0_g0.slpz 1_g1.slpz 2_g2.slpz lunar-manifest.json");
  });

  it("ships the original .slp when slpz can't compress a game, instead of dropping it", async () => {
    await seed(2);
    fs.unlinkSync(path.join(root, "g1.slpz")); // cache miss
    const saved = config.slpzBinary;
    (config as any).slpzBinary = "/bin/true"; // like slpz on a never-finalized recording: exits 0, writes nothing
    try {
      const job = await Job.create({ filter: { p1ConnectCode: "S#1" }, createdBy: "c", estimatedSize: 2000, replayCount: 2 });
      await processNextCompression();
      expect((await Job.findById(job._id).lean())!).toMatchObject({ status: "completed", replayCount: 2 });
      const zipPath = path.join(os.tmpdir(), `${job._id}.zip`);
      fs.writeFileSync(zipPath, uploaded!);
      const names = execFileSync("python3", ["-c", "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read('lunar-manifest.json')); print(' '.join(sorted(r['file'] for r in m['replays'])))", zipPath]).toString().trim();
      fs.unlinkSync(zipPath);
      expect(names).toBe("0_g0.slpz 1_g1.slp");
    } finally {
      (config as any).slpzBinary = saved;
    }
  });

  it("puts the job back in line after a network error instead of failing it", async () => {
    await seed(2);
    failUpload = new Error("write EPROTO wrong version number");
    const job = await Job.create({ filter: { p1ConnectCode: "S#1" }, createdBy: "c", estimatedSize: 2000, replayCount: 2 });
    await processNextCompression();
    expect((await Job.findById(job._id).lean())!).toMatchObject({ status: "pending", uploadAttempts: 1, progress: null });
  });
});
