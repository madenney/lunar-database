import { parentPort, threadId } from "worker_threads";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { extractGameStats } from "./gameStats";

// Parses replays for scripts/extractStats.ts. Prefers the .slpz copy (about 9x less
// disk reading), decompressed into RAM, and falls back to the raw .slp.
type Job = { id: string; filePath: string };
type Msg = { jobs: Job[]; slpRoot: string; slpzRoot: string; slpzBinary: string };

const TMP = path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : "/tmp", `lm-stats-${process.pid}-${threadId}.slp`);

parentPort!.on("message", (msg: Msg) => {
  const results = msg.jobs.map((job) => {
    try {
      const slpz = path.join(msg.slpzRoot, job.filePath.replace(/\.slp$/i, ".slpz"));
      let file = path.join(msg.slpRoot, job.filePath);
      if (fs.existsSync(slpz)) {
        fs.rmSync(TMP, { force: true });
        execFileSync(msg.slpzBinary, ["-q", "-d", "-o", TMP, slpz], { timeout: 60_000 });
        file = TMP;
      }
      const out = extractGameStats(file);
      return { id: job.id, ...out };
    } catch (err) {
      return { id: job.id, error: String((err as Error).message).slice(0, 200) };
    } finally {
      fs.rmSync(TMP, { force: true });
    }
  });
  parentPort!.postMessage(results);
});
