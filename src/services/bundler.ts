import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config";

const execFileAsync = promisify(execFile);

/** Yield to the event loop so Express can handle requests */
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

export interface BundleResult {
  zipPath: string;
  size: number;
}

export interface BundleProgressCallback {
  (filesProcessed: number, filesTotal: number): void;
}

/** Check free disk space on the partition containing jobTempDir (in bytes). */
async function getFreeDiskBytes(): Promise<number> {
  const target = fs.existsSync(config.jobTempDir) ? config.jobTempDir : path.dirname(config.jobTempDir);
  const { stdout } = await execFileAsync("df", ["-B1", "--output=avail", target]);
  const lines = stdout.trim().split("\n");
  return parseInt(lines[lines.length - 1].trim(), 10);
}

/**
 * Creates a compressed bundle:
 * 1. Compress each .slp directly to temp dir using `slpz -x -o <out.slpz> <source.slp>`
 *    (never copies, moves, or modifies original .slp files)
 * 2. Zip the .slpz files in store mode (no compression — slpz already compressed)
 */
export async function createBundle(
  filePaths: string[],
  jobId: string,
  onProgress?: BundleProgressCallback
): Promise<BundleResult> {
  // Pre-flight disk space check
  const freeBytes = await getFreeDiskBytes();
  const freeMb = freeBytes / (1024 * 1024);
  if (freeMb < config.minFreeDiskMb) {
    throw new Error(
      `Insufficient disk space: ${Math.round(freeMb)}MB free, need at least ${config.minFreeDiskMb}MB`
    );
  }

  const jobDir = path.join(config.jobTempDir, jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  const slpzTimeoutMs = config.slpzTimeoutMinutes * 60 * 1000;
  const perFileTimeoutMs = 60 * 1000; // 1 minute per file

  // Compress each .slp directly to temp dir as .slpz
  // Use index prefix to prevent filename collisions (e.g. two different Game_20240101T000000.slp)
  let compressed = 0;
  for (let i = 0; i < filePaths.length; i++) {
    const fp = filePaths[i];
    const outName = `${i}_${path.basename(fp, ".slp")}.slpz`;
    const outPath = path.join(jobDir, outName);
    try {
      await execFileAsync(config.slpzBinary, ["-x", "-o", outPath, fp], {
        timeout: perFileTimeoutMs,
        killSignal: "SIGKILL",
      });
      compressed++;
      if (onProgress && compressed % 100 === 0) {
        onProgress(compressed, filePaths.length);
      }
      // Yield every 50 files so Express can serve requests
      if (compressed % 50 === 0) await yieldToEventLoop();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = (err as Error).message;
      // ENOENT from execFile can mean either the binary or the source file is missing.
      // If the binary isn't found, bail immediately — no point continuing.
      if (code === "ENOENT" && msg.includes("spawn " + config.slpzBinary)) {
        throw new Error(`slpz binary not found at ${config.slpzBinary} — is it installed?`);
      }
      // Source file missing (deleted since query); skip silently
      if (code !== "ENOENT" && !msg.includes("No such file")) {
        console.error(`Failed to compress ${fp}:`, msg);
      }
      // Clean up partial output if slpz failed mid-write
      try { await fsp.unlink(outPath); } catch {}
    }

    // Re-check disk space every 500 files
    if (compressed > 0 && compressed % 500 === 0) {
      const currentFree = await getFreeDiskBytes();
      if (currentFree / (1024 * 1024) < config.minFreeDiskMb) {
        cleanupJobTemp(jobId);
        throw new Error(
          `Disk space dropped below ${config.minFreeDiskMb}MB during compression — aborting`
        );
      }
    }
  }
  if (onProgress) onProgress(compressed, filePaths.length);

  if (compressed === 0) {
    cleanupJobTemp(jobId);
    throw new Error("No files were compressed for bundling");
  }

  // Zip the .slpz files (store mode — no compression, slpz is already compressed)
  const zipPath = path.join(config.jobTempDir, `${jobId}.zip`);
  const slpzFiles = await fsp.readdir(jobDir);
  await execFileAsync("zip", ["-0", "-j", zipPath, ...slpzFiles.map((f) => path.join(jobDir, f))], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: slpzTimeoutMs,
    killSignal: "SIGKILL",
  });

  const stat = await fsp.stat(zipPath);

  // Clean up the temp directory (keep the zip)
  await fsp.rm(jobDir, { recursive: true, force: true });

  return { zipPath, size: stat.size };
}

/**
 * Clean up temp directory and tar file for a job.
 */
export function cleanupJobTemp(jobId: string): void {
  if (!/^[a-f0-9]{24}$/.test(jobId)) {
    console.error(`cleanupJobTemp: invalid jobId "${jobId}"`);
    return;
  }
  const jobDir = path.join(config.jobTempDir, jobId);
  const zipPath = path.join(config.jobTempDir, `${jobId}.zip`);

  try {
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to clean job dir ${jobDir}:`, (err as Error).message);
  }
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  } catch (err) {
    console.error(`Failed to clean zip ${zipPath}:`, (err as Error).message);
  }
}

/**
 * Remove orphaned temp directories/tars older than maxAgeMs.
 * Called on startup to clean up after crashes.
 */
export async function cleanupOrphanedTemp(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const dir = config.jobTempDir;
  if (!fs.existsSync(dir)) return 0;

  const now = Date.now();
  let cleaned = 0;
  const entries = await fsp.readdir(dir);

  for (const entry of entries) {
    try {
      const fp = path.join(dir, entry);
      const stat = await fsp.stat(fp);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fsp.rm(fp, { recursive: true, force: true });
        cleaned++;
        console.log(`Cleaned orphaned temp: ${entry}`);
      }
    } catch (err) {
      console.error(`Failed to clean orphaned temp ${entry}:`, (err as Error).message);
    }
  }

  return cleaned;
}

/**
 * Get disk usage of jobTempDir in bytes.
 */
export async function getTempDiskUsage(): Promise<{ usedBytes: number; freeBytes: number; entries: number }> {
  const dir = config.jobTempDir;
  let usedBytes = 0;
  let entries = 0;

  if (fs.existsSync(dir)) {
    const items = await fsp.readdir(dir);
    entries = items.length;
    for (const item of items) {
      try {
        const fp = path.join(dir, item);
        const stat = await fsp.stat(fp);
        if (stat.isDirectory()) {
          // Sum directory contents
          const { stdout } = await execFileAsync("du", ["-sb", fp]);
          usedBytes += parseInt(stdout.split("\t")[0], 10);
        } else {
          usedBytes += stat.size;
        }
      } catch (err) {
        console.error(`Failed to stat temp entry ${item}:`, (err as Error).message);
      }
    }
  }

  let freeBytes = 0;
  try {
    freeBytes = await getFreeDiskBytes();
  } catch {}

  return { usedBytes, freeBytes, entries };
}
