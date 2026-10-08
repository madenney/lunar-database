import { BytePacer, StreamGate } from "./replayStreams";

describe("StreamGate", () => {
  it("admits up to max at once and hands a freed slot to the oldest waiter", async () => {
    const gate = new StreamGate(2);
    const a = await gate.acquire(1000);
    const b = await gate.acquire(1000);
    expect(a && b).toBeTruthy();
    const order: string[] = [];
    const c = gate.acquire(1000).then((r) => (order.push("c"), r));
    const d = gate.acquire(1000).then((r) => (order.push("d"), r));
    expect(gate.stats).toEqual({ active: 2, waiting: 2, max: 2 });
    a!();
    a!(); // releasing twice frees one slot only
    const rc = await c;
    expect(order).toEqual(["c"]);
    expect(gate.stats).toEqual({ active: 2, waiting: 1, max: 2 });
    b!();
    const rd = await d;
    expect(order).toEqual(["c", "d"]);
    rc!();
    rd!();
    expect(gate.stats).toEqual({ active: 0, waiting: 0, max: 2 });
  });

  it("gives up after waitMs and leaves no stale waiter behind", async () => {
    const gate = new StreamGate(1);
    const a = await gate.acquire(1000);
    expect(await gate.acquire(20)).toBeNull();
    expect(gate.stats.waiting).toBe(0);
    a!();
    expect(gate.stats.active).toBe(0);
  });
});

describe("BytePacer", () => {
  it("books bytes back to back across callers at the given rate", () => {
    let t = 1000;
    const pacer = new BytePacer(1000, () => t); // 1,000 bytes/s
    expect(pacer.reserve(500)).toBe(0); // free now; busy until t+500 ms
    expect(pacer.reserve(500)).toBe(500); // another stream's chunk waits its turn
    t += 2000; // idle time isn't banked as burst credit
    expect(pacer.reserve(1000)).toBe(0);
    expect(pacer.reserve(1)).toBe(1000);
  });

  it("passes bytes through unchanged", async () => {
    const pacer = new BytePacer(10_000_000);
    const s = pacer.stream();
    const out: Buffer[] = [];
    s.on("data", (c: Buffer) => out.push(c));
    const done = new Promise((r) => s.on("end", r));
    s.write(Buffer.from("abc"));
    s.end(Buffer.from("def"));
    await done;
    expect(Buffer.concat(out).toString()).toBe("abcdef");
  });
});
