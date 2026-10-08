import { Transform } from "stream";

/**
 * A cap on concurrent replay downloads. Every replay view streams its .slp over the
 * home uplink (~53 Mbit/s), the same link every search and page answer crosses. In
 * the 2026-10-07 launch test, 500 visitors opening replays filled it: replays timed
 * out at 30 s and the home page's p95 reached 11 s. With a few streams at a time
 * the uplink still carries the same replays per second, the rest wait their turn
 * (FIFO), and a waiter that can't start in time gets a quick "busy" instead.
 */
export class StreamGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Resolves to a release function, or null if no slot opened within waitMs. */
  acquire(waitMs: number): Promise<(() => void) | null> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== grant);
        resolve(null);
      }, waitMs);
      this.waiters.push(grant);
    });
  }

  get stats(): { active: number; waiting: number; max: number } {
    return { active: this.active, waiting: this.waiters.length, max: this.max };
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else this.active--;
    };
  }
}

/**
 * A shared byte-rate budget for replay downloads. The concurrency gate alone isn't
 * enough: cloudflared reads each response from the API at local speed and buffers
 * it, so a stream "finishes" here long before its bytes cross the uplink, and the
 * queue just moves into the tunnel (the 2026-10-07 retest: no gate waits, replays
 * still 32 s, uplink full, pages slow). Pacing every replay chunk through one
 * budget keeps replays to part of the uplink; chunks from all streams take turns.
 */
export class BytePacer {
  private nextFree = 0;

  constructor(private readonly bytesPerSec: number, private readonly now: () => number = Date.now) {}

  /** Milliseconds to wait before sending n bytes (and books them). */
  reserve(n: number): number {
    const t = this.now();
    const start = Math.max(t, this.nextFree);
    this.nextFree = start + (n / this.bytesPerSec) * 1000;
    return start - t;
  }

  /** A pass-through stream that sends at most this pacer's budget, shared with every other stream. */
  stream(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        const wait = this.reserve(chunk.length);
        if (wait <= 0) done(null, chunk);
        else setTimeout(() => done(null, chunk), wait);
      },
    });
  }
}
