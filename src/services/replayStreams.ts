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
