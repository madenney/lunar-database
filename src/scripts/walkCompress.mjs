#!/usr/bin/env node
/**
 * Standalone .slp -> .slpz backfill compressor.
 *
 * Built to run ON THE WORKER (192.168.1.132), where the replay archive is LOCAL
 * disk instead of an NFS mount. Reading each .slp locally is ~45x faster than
 * over NFS, so this finishes the backfill in ~hours instead of ~2 weeks.
 *
 * ZERO dependencies: only Node stdlib + the slpz binary. No MongoDB, no ts-node,
 * no repo install. Enumerates files by walking the filesystem (catches every
 * .slp on disk, indexed or not) and mirrors the source tree into the dest dir,
 * exactly like the live bundler's cache layout. Resumable — skips any .slp whose
 * .slpz already exists. Crash-safe — writes to a temp file then atomically
 * renames, so an interrupted run never leaves a half-written .slpz behind.
 *
 * Usage (on the worker):
 *   node walkCompress.mjs \
 *     --src   /home/matt/Projects/worker/shared_folder/netplay \
 *     --dest  /home/matt/Projects/worker/shared_folder/slpz/netplay \
 *     --slpz  /usr/local/bin/slpz \
 *     --concurrency 32
 *
 *   Add --dry-run to count work without compressing.
 *
 * IMPORTANT: stop the belphegor-side backfill (compressAll.ts) before running
 * this, so two processes don't write the same .slpz over each other.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const PER_FILE_TIMEOUT_MS = 60_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    src: "",
    dest: "",
    slpz: "/usr/local/bin/slpz",
    concurrency: Math.max(4, os.cpus().length),
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--src") opts.src = args[++i];
    else if (a === "--dest") opts.dest = args[++i];
    else if (a === "--slpz") opts.slpz = args[++i];
    else if (a === "--concurrency") opts.concurrency = parseInt(args[++i], 10);
    else if (a === "--dry-run") opts.dryRun = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.src || !opts.dest) {
    console.error("Required: --src <dir> --dest <dir>  [--slpz <bin>] [--concurrency N] [--dry-run]");
    process.exit(2);
  }
  opts.src = path.resolve(opts.src);
  opts.dest = path.resolve(opts.dest);
  return opts;
}

/**
 * Recursively yield every *.slp file under root, skipping the dest subtree
 * (the slpz output dir lives inside the source tree) and hidden/junk dirs.
 */
async function* walkSlp(dir, destRoot) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Never descend into the output tree or trash/lost+found
      if (full === destRoot) continue;
      if (ent.name === "lost+found" || ent.name.startsWith(".Trash")) continue;
      yield* walkSlp(full, destRoot);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".slp")) {
      yield full;
    }
  }
}

async function compressOne(srcPath, destPath, slpzBin) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  // Write to a unique temp file, then atomic rename into place. Prevents a
  // half-written .slpz from looking "done" to the resume logic if we crash.
  const tmp = `${destPath}.tmp.${process.pid}.${Math.floor(performance.now() * 1000) % 1_000_000}`;
  try {
    await execFileAsync(slpzBin, ["-x", "-o", tmp, srcPath], {
      timeout: PER_FILE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    await fsp.rename(tmp, destPath);
    return true;
  } catch (err) {
    try { await fsp.unlink(tmp); } catch {}
    const msg = (err && err.message) || String(err);
    if (msg.includes("ENOENT") && msg.includes(slpzBin)) {
      throw new Error(`slpz binary not found at ${slpzBin}`);
    }
    return false;
  }
}

async function main() {
  const opts = parseArgs();
  console.log(`src:         ${opts.src}`);
  console.log(`dest:        ${opts.dest}`);
  console.log(`slpz binary: ${opts.slpz}`);
  console.log(`concurrency: ${opts.concurrency}`);
  if (opts.dryRun) console.log("DRY RUN — nothing will be compressed");
  console.log("");

  await fsp.mkdir(opts.dest, { recursive: true });

  const startTime = performance.now();
  let seen = 0, compressed = 0, skipped = 0, failed = 0;

  function logProgress() {
    const elapsed = (performance.now() - startTime) / 1000;
    const rate = compressed / elapsed;
    console.log(
      `[seen ${seen.toLocaleString()}] compressed=${compressed.toLocaleString()} ` +
      `skipped=${skipped.toLocaleString()} failed=${failed.toLocaleString()} ` +
      `rate=${rate.toFixed(1)}/s elapsed=${Math.round(elapsed)}s`
    );
  }

  // Bounded-concurrency worker pool fed by the filesystem walk.
  const inFlight = new Set();

  async function schedule(srcPath) {
    const rel = path.relative(opts.src, srcPath);
    const destPath = path.join(opts.dest, rel.replace(/\.slp$/i, ".slpz"));

    // Resume: skip anything already compressed.
    if (fs.existsSync(destPath)) { skipped++; return; }
    if (opts.dryRun) { compressed++; return; }

    const p = compressOne(srcPath, destPath, opts.slpz)
      .then((ok) => { ok ? compressed++ : failed++; })
      .catch((fatal) => { console.error("\nFATAL:", fatal.message); process.exit(1); })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);

    if (inFlight.size >= opts.concurrency) {
      await Promise.race(inFlight);
    }
  }

  for await (const srcPath of walkSlp(opts.src, opts.dest)) {
    seen++;
    await schedule(srcPath);
    if (seen % 10_000 === 0) logProgress();
  }

  await Promise.all(inFlight);
  logProgress();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
