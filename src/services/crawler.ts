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

  for (const filePath of walkDir(dir)) {
    if (!skipDupeCheck) {
      const existing = await Replay.findOne({ filePath });
      if (existing) {
        skipped++;
        continue;
      }
    }

    const result = parseOneFile(filePath, dir);
    if (result) {
      batch.push(result);
    } else {
      errors++;
    }

    if (batch.length >= config.crawlerBatchSize) {
      await saveBatch(batch);
      indexed += batch.length;
      batch = [];
      console.log(`Indexed: ${indexed}, Skipped: ${skipped}, Errors: ${errors}`);
    }
  }

  if (batch.length > 0) {
    await saveBatch(batch);
    indexed += batch.length;
  }

  console.log(`Done. Indexed: ${indexed}, Skipped: ${skipped}, Errors: ${errors}`);
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
    // Ignore duplicate key errors (code 11000) from concurrent runs
    if (err.code !== 11000) {
      console.error("Batch insert error:", err.message);
    }
  }
}
