import { config } from "../config";
import { cleanupExpiredJobs } from "../services/storageCleanup";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function isCleanupRunning(): boolean {
  return running;
}

async function runCleanup(): Promise<void> {
  try {
    const result = await cleanupExpiredJobs(config.storageCleanupAfterDays);
    if (result.cleaned > 0 || result.errors > 0) {
      const freedMb = (result.freedBytes / 1024 / 1024).toFixed(1);
      console.log(
        `Storage cleanup: ${result.cleaned} expired jobs cleared (${freedMb} MB), ${result.errors} errors`
      );
    }
  } catch (err) {
    console.error("Cleanup worker error:", (err as Error).message);
  }
}

export function startCleanupWorker(): void {
  running = true;
  console.log("Cleanup worker started");

  const intervalMs = config.storageCleanupIntervalMinutes * 60 * 1000;

  const tick = async () => {
    if (!running) return;
    await runCleanup();
    if (running) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  tick();
}

export function stopCleanupWorker(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log("Cleanup worker stopped");
}
