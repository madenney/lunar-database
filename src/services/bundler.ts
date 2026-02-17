import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config";

const execFileAsync = promisify(execFile);

export interface BundleResult {
  tarPath: string;
  size: number;
}

export interface BundleProgressCallback {
  (filesProcessed: number, filesTotal: number): void;
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
  const jobDir = path.join(config.jobTempDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Copy .slp files to temp dir
  let copied = 0;
  for (const fp of filePaths) {
    try {
      if (fs.existsSync(fp)) {
        fs.copyFileSync(fp, path.join(jobDir, path.basename(fp)));
        copied++;
        if (onProgress && copied % 100 === 0) {
          onProgress(copied, filePaths.length);
        }
      }
    } catch (err) {
      console.error(`Failed to copy ${fp}:`, (err as Error).message);
    }
  }
  if (onProgress) onProgress(copied, filePaths.length);

  if (copied === 0) {
    cleanupJobTemp(jobId);
    throw new Error("No files were copied for bundling");
  }

  // Run slpz to compress .slp → .slpz (removes originals with --rm)
  await execFileAsync("slpz", ["-r", "--rm", "-x", jobDir]);

  // Tar the .slpz files
  const tarPath = path.join(config.jobTempDir, `${jobId}.tar`);
  await execFileAsync("tar", ["-cf", tarPath, "-C", jobDir, "."]);

  const stat = fs.statSync(tarPath);

  // Clean up the temp directory (keep the tar)
  fs.rmSync(jobDir, { recursive: true, force: true });

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
