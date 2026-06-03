/**
 * Compress all .slp replays in the database to .slpz format.
 *
 * Output: /home/matt/Projects/worker/hax_archive/slpz/
 * Mirrors the relative directory structure from SLP_ROOT_DIR.
 * Resumable — skips files that already exist in the output dir.
 *
 * Usage: npx ts-node src/scripts/compressAll.ts [--concurrency N] [--dry-run]
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { connectDb } from "../db";
import { config } from "../config";

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = "/home/matt/Projects/worker/hax_archive/slpz";
const PER_FILE_TIMEOUT_MS = 60_000;

function parseArgs() {
  const args = process.argv.slice(2);
  let concurrency = 4;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--concurrency" && args[i + 1]) {
      concurrency = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === "--dry-run") dryRun = true;
  }
  return { concurrency, dryRun };
}

async function compressFile(srcPath: string, destPath: string): Promise<boolean> {
  try {
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await execFileAsync(config.slpzBinary, ["-x", "-o", destPath, srcPath], {
      timeout: PER_FILE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return true;
  } catch (err) {
    // Clean up partial output
    try { await fsp.unlink(destPath); } catch {}
    const msg = (err as Error).message;
    if (msg.includes("spawn " + config.slpzBinary)) {
      throw new Error(`slpz binary not found at ${config.slpzBinary}`);
    }
    return false;
  }
}

async function main() {
  const { concurrency, dryRun } = parseArgs();

  await connectDb();
  const total = await Replay.countDocuments({});
  console.log(`Total replays in DB: ${total.toLocaleString()}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Concurrency: ${concurrency}`);
  if (dryRun) console.log("DRY RUN — no files will be compressed");

  await fsp.mkdir(OUTPUT_DIR, { recursive: true });

  const cursor = Replay.find({}, { filePath: 1 }).lean().cursor({ batchSize: 5000 });

  let processed = 0;
  let compressed = 0;
  let skipped = 0;
  let failed = 0;
  let missing = 0;
  const startTime = Date.now();

  // Process files in batches for concurrency
  let batch: { src: string; dest: string }[] = [];

  async function flushBatch() {
    const results = await Promise.all(
      batch.map(({ src, dest }) => compressFile(src, dest))
    );
    for (const ok of results) {
      if (ok) compressed++;
      else failed++;
    }
    batch = [];
  }

  for await (const replay of cursor) {
    processed++;
    const relPath = replay.filePath;
    const srcPath = path.join(config.slpRootDir, relPath);
    const destPath = path.join(OUTPUT_DIR, relPath.replace(/\.slp$/i, ".slpz"));

    // Skip if already compressed
    if (fs.existsSync(destPath)) {
      skipped++;
      if (processed % 50000 === 0) logProgress();
      continue;
    }

    // Skip if source missing
    if (!fs.existsSync(srcPath)) {
      missing++;
      if (processed % 50000 === 0) logProgress();
      continue;
    }

    if (dryRun) {
      compressed++;
      if (processed % 50000 === 0) logProgress();
      continue;
    }

    batch.push({ src: srcPath, dest: destPath });
    if (batch.length >= concurrency) {
      await flushBatch();
    }

    if (processed % 10000 === 0) logProgress();
  }

  // Flush remaining
  if (batch.length > 0) await flushBatch();

  logProgress();
  console.log("\nDone!");
  await mongoose.disconnect();

  function logProgress() {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = compressed / elapsed;
    const remaining = total - processed;
    const eta = rate > 0 ? remaining / rate : 0;
    const etaMin = Math.round(eta / 60);
    console.log(
      `[${processed.toLocaleString()}/${total.toLocaleString()}] ` +
      `compressed=${compressed.toLocaleString()} skipped=${skipped.toLocaleString()} ` +
      `failed=${failed.toLocaleString()} missing=${missing.toLocaleString()} ` +
      `rate=${rate.toFixed(0)}/s ETA=${etaMin}m`
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
