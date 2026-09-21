import { config } from "../config";
import { reapStuckJobs } from "../services/reapStuckJobs";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isReaperRunning(): boolean {
  return running;
}

async function runReaper(): Promise<void> {
  try {
    const { reaped } = await reapStuckJobs(config.jobStuckAfterMinutes);
    if (reaped > 0) {
      console.log(`Reaper: failed ${reaped} stuck job(s) (> ${config.jobStuckAfterMinutes}min in an active state)`);
    }
  } catch (err) {
    console.error("Reaper worker error:", (err as Error).message);
  }
}

export function startReaper(): void {
  running = true;
  console.log("Reaper worker started");

  const intervalMs = config.jobReaperIntervalMinutes * 60 * 1000;

  const tick = async () => {
    if (!running) return;
    await runReaper();
    if (running) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  tick();
}

export function stopReaper(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("Reaper worker stopped");
}
