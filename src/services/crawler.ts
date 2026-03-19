import fs from "fs";
import path from "path";
import os from "os";
import { Worker } from "worker_threads";
import { Replay } from "../models/Replay";
import { config } from "../config";

const WORKER_BATCH = 200; // files per worker message
const SAVE_BATCH = 1000;  // docs per insertMany

function* walkDir(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.name.endsWith(".slp")) {
      yield fullPath;
    }
  }
}

function createWorker(workerPath: string): Worker {
  return new Worker(workerPath, { execArgv: ["--require", "ts-node/register"] });
}

function parseViaWorker(worker: Worker, relPaths: string[], rootDir: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.postMessage({ relPaths, rootDir });
  });
}

export interface CrawlOptions {
  skipDupeCheck?: boolean;
}

export async function crawl(rootDir?: string, opts: CrawlOptions = {}): Promise<void> {
  const dir = rootDir || config.slpRootDir;
  const skipDupeCheck = opts.skipDupeCheck ?? false;
  const numWorkers = Math.max(1, os.cpus().length - 2); // leave 2 cores for mongo + system
  console.log(`Crawling ${dir} with ${numWorkers} workers...${skipDupeCheck ? " (skipping dupe check)" : ""}`);

  const workerPath = path.join(__dirname, "crawlWorker.ts");
  const workers = Array.from({ length: numWorkers }, () => createWorker(workerPath));

  let indexed = 0;
  let errors = 0;
  let skipped = 0;
  let saveBuf: any[] = [];
  let pathBuf: string[] = [];

  // Round-robin dispatch to workers
  let workerIdx = 0;
  const pendingWork: Promise<any[]>[] = [];

  async function flushWorkers() {
    if (pendingWork.length === 0) return;
    const results = await Promise.all(pendingWork);
    pendingWork.length = 0;

    for (const batch of results) {
      saveBuf.push(...batch);
      errors += WORKER_BATCH - batch.length; // rough error count
    }

    while (saveBuf.length >= SAVE_BATCH) {
      const toSave = saveBuf.splice(0, SAVE_BATCH);
      await saveBatch(toSave);
      indexed += toSave.length;
      console.log(`Indexed: ${indexed}, Errors: ${errors}`);
    }
  }

  async function dispatchBatch(paths: string[]) {
    // Dupe check
    let toProcess = paths;
    if (!skipDupeCheck) {
      const existing = await Replay.find({ filePath: { $in: paths } })
        .select("filePath").lean();
      const existingSet = new Set(existing.map((r) => r.filePath));
      skipped += existingSet.size;
      toProcess = paths.filter((p) => !existingSet.has(p));
    }

    if (toProcess.length === 0) return;

    const worker = workers[workerIdx % workers.length];
    workerIdx++;
    pendingWork.push(parseViaWorker(worker, toProcess, dir));

    // Flush when all workers are busy
    if (pendingWork.length >= numWorkers) {
      await flushWorkers();
    }
  }

  for (const absolutePath of walkDir(dir)) {
    pathBuf.push(path.relative(dir, absolutePath));

    if (pathBuf.length >= WORKER_BATCH) {
      await dispatchBatch(pathBuf);
      pathBuf = [];
    }
  }

  // Remaining paths
  if (pathBuf.length > 0) {
    await dispatchBatch(pathBuf);
  }

  // Flush remaining work
  await flushWorkers();

  if (saveBuf.length > 0) {
    await saveBatch(saveBuf);
    indexed += saveBuf.length;
  }

  // Terminate workers
  await Promise.all(workers.map((w) => w.terminate()));

  console.log(`Done. Indexed: ${indexed}, Skipped: ${skipped}, Errors: ${errors}`);
}

async function saveBatch(batch: any[]) {
  try {
    await Replay.insertMany(batch, { ordered: false });
  } catch (err: any) {
    if (err.code !== 11000) {
      throw err;
    }
  }
}
