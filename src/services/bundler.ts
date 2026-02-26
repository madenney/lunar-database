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
  tarPath: string;
  size: number;
}

export interface BundleProgressCallback {
  (filesProcessed: number, filesTotal: number): void;
}

/** Check free disk space on the partition containing jobTempDir (in bytes). */
async function getFreeDiskBytes(): Promise<number> {
  const { stdout } = await execFileAsync("df", ["-B1", "--output=avail", config.jobTempDir]);
  const lines = stdout.trim().split("\n");
  return parseInt(lines[lines.length - 1].trim(), 10);
}

/** Estimate disk space needed: raw copies + compressed tar headroom */
function estimateDiskNeeded(filePaths: string[], avgFileSize: number): number {
  // Need space for: copies (raw) + slpz output (~raw/8) + tar (~slpz + overhead)
  // Peak usage is during copy phase before slpz --rm deletes originals
  const rawBytes = filePaths.length * avgFileSize;
  // Conservative: assume we need raw copies + final tar (slpz deletes originals, so peak is copies)
  return rawBytes + rawBytes / 8 + filePaths.length * 1024;
}

/**
 * Creates a compressed bundle:
 * 1. Copy .slp files to a temp dir
 * 2. Run `slpz -r --rm -x <tempDir>` to compress .slp → .slpz in-place
 * 3. Tar the .slpz files (no gzip — slpz already compressed)
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

  // Copy .slp files to temp dir (async to avoid blocking the event loop)
  let copied = 0;
  for (const fp of filePaths) {
    try {
      await fsp.copyFile(fp, path.join(jobDir, path.basename(fp)));
      copied++;
      if (onProgress && copied % 100 === 0) {
        onProgress(copied, filePaths.length);
      }
      // Yield every 50 files so Express can serve requests
      if (copied % 50 === 0) await yieldToEventLoop();
    } catch (err) {
      // ENOENT is expected if file was deleted since query; skip silently
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to copy ${fp}:`, (err as Error).message);
      }
    }

    // Re-check disk space every 500 files
    if (copied % 500 === 0) {
      const currentFree = await getFreeDiskBytes();
      if (currentFree / (1024 * 1024) < config.minFreeDiskMb) {
        cleanupJobTemp(jobId);
        throw new Error(
          `Disk space dropped below ${config.minFreeDiskMb}MB during copy — aborting`
        );
      }
    }
  }
  if (onProgress) onProgress(copied, filePaths.length);

  if (copied === 0) {
    cleanupJobTemp(jobId);
    throw new Error("No files were copied for bundling");
  }

  // Run slpz to compress .slp → .slpz (removes originals with --rm)
  await execFileAsync("slpz", ["-r", "--rm", "-x", jobDir], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: slpzTimeoutMs,
  });

  // Tar the .slpz files (should be fast, but cap at same timeout for safety)
  const tarPath = path.join(config.jobTempDir, `${jobId}.tar`);
  await execFileAsync("tar", ["-cf", tarPath, "-C", jobDir, "."], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: slpzTimeoutMs,
  });

  const stat = await fsp.stat(tarPath);

  // Clean up the temp directory (keep the tar)
  await fsp.rm(jobDir, { recursive: true, force: true });

  return { tarPath, size: stat.size };
}

/**
 * Clean up temp directory and tar file for a job.
 */
export function cleanupJobTemp(jobId: string): void {
  const jobDir = path.join(config.jobTempDir, jobId);
  const tarPath = path.join(config.jobTempDir, `${jobId}.tar`);

  try {
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to clean job dir ${jobDir}:`, (err as Error).message);
  }
  try {
    if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
  } catch (err) {
    console.error(`Failed to clean tar ${tarPath}:`, (err as Error).message);
  }
}

/**
 * Legacy cleanup for old zip bundles in bundlesDir.
 */
export function cleanupOldBundles(): number {
  if (!fs.existsSync(config.bundlesDir)) return 0;

  const maxAge = config.bundleMaxAgeHours * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;

  const files = fs.readdirSync(config.bundlesDir);
  for (const file of files) {
    try {
      const fp = path.join(config.bundlesDir, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
        cleaned++;
      }
    } catch (err) {
      console.error(`Failed to clean up bundle ${file}:`, (err as Error).message);
    }
  }

  return cleaned;
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
      } catch {}
    }
  }

  let freeBytes = 0;
  try {
    freeBytes = await getFreeDiskBytes();
  } catch {}

  return { usedBytes, freeBytes, entries };
}
