import { StreamGate } from "./replayStreams";

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
