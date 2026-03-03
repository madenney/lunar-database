import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Replay } from "../models/Replay";
import { parseSlpFile } from "./slpParser";
import { config } from "../config";

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

function getFolderLabel(filePath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, path.dirname(filePath));
  return rel || null;
}

export interface CrawlOptions {
  skipDupeCheck?: boolean;
}

export async function crawl(rootDir?: string, opts: CrawlOptions = {}): Promise<void> {
  const dir = rootDir || config.slpRootDir;
  const skipDupeCheck = opts.skipDupeCheck ?? false;
  console.log(`Crawling ${dir}...${skipDupeCheck ? " (skipping dupe check)" : ""}`);

  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  let batch: NonNullable<ReturnType<typeof parseOneFile>>[] = [];

  // Collect file paths in chunks to batch dupe checks with $in instead of N+1 findOne
  let pathBuffer: string[] = [];

  for (const filePath of walkDir(dir)) {
    pathBuffer.push(filePath);

    if (pathBuffer.length >= config.crawlerBatchSize) {
      const result = await processPaths(pathBuffer, dir, skipDupeCheck, batch);
      skipped += result.skipped;
      errors += result.errors;
      batch = result.batch;

      if (batch.length >= config.crawlerBatchSize) {
        await saveBatch(batch);
        indexed += batch.length;
        batch = [];
        console.log(`Indexed: ${indexed}, Skipped: ${skipped}, Errors: ${errors}`);
      }
      pathBuffer = [];
    }
  }

  // Process remaining paths
  if (pathBuffer.length > 0) {
    const result = await processPaths(pathBuffer, dir, skipDupeCheck, batch);
    skipped += result.skipped;
    errors += result.errors;
    batch = result.batch;
  }

  if (batch.length > 0) {
    await saveBatch(batch);
    indexed += batch.length;
  }

  console.log(`Done. Indexed: ${indexed}, Skipped: ${skipped}, Errors: ${errors}`);
}

async function processPaths(
  paths: string[],
  rootDir: string,
  skipDupeCheck: boolean,
  batch: NonNullable<ReturnType<typeof parseOneFile>>[]
) {
  let skipped = 0;
  let errors = 0;
  let toProcess = paths;

  if (!skipDupeCheck) {
    const existing = await Replay.find({ filePath: { $in: paths } })
      .select("filePath")
      .lean();
    const existingSet = new Set(existing.map((r) => r.filePath));
    skipped = existingSet.size;
    toProcess = paths.filter((p) => !existingSet.has(p));
  }

  for (const filePath of toProcess) {
    const result = parseOneFile(filePath, rootDir);
    if (result) {
      batch.push(result);
    } else {
      errors++;
    }
  }

  return { batch, skipped, errors };
}

function parseOneFile(filePath: string, rootDir: string) {
  try {
    const parsed = parseSlpFile(filePath);
    const stat = fs.statSync(filePath);
    // Use file size + mtime as a quick hash to avoid reading the full file
    const fileHash = crypto
      .createHash("md5")
      .update(`${stat.size}-${stat.mtimeMs}`)
      .digest("hex");

    return {
      filePath,
      fileHash,
      fileSize: stat.size,
      folderLabel: getFolderLabel(filePath, rootDir),
      ...parsed,
      indexedAt: new Date(),
    };
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, (err as Error).message);
    return null;
  }
}

async function saveBatch(batch: NonNullable<ReturnType<typeof parseOneFile>>[]) {
  try {
    await Replay.insertMany(batch, { ordered: false });
  } catch (err: any) {
    // Duplicate key errors (code 11000) are expected from concurrent runs or re-crawls
    if (err.code !== 11000) {
      throw err;
    }
  }
}
