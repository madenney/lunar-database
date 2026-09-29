import { QueryCache, paramsKey } from "./queryCache";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("QueryCache", () => {
  it("reuses a result and shares one query between simultaneous identical requests", async () => {
    const c = new QueryCache(60_000, 100, 4, true);
    let runs = 0;
    const slow = async () => { runs++; await tick(); return 42; };
    const [a, b, d] = await Promise.all([c.get("k", slow), c.get("k", slow), c.get("k", slow)]);
    expect([a, b, d]).toEqual([42, 42, 42]);
    expect(await c.get("k", slow)).toBe(42);
    expect(runs).toBe(1);
  });

  it("expires entries after the TTL", async () => {
    const c = new QueryCache(1, 100, 4, true);
    let runs = 0;
    await c.get("k", async () => ++runs);
    await tick();
    expect(await c.get("k", async () => ++runs)).toBe(2);
  });

  it("never runs more than maxHeavy queries at once", async () => {
    const c = new QueryCache(60_000, 100, 2, true);
    let running = 0, peak = 0;
    const job = async () => { running++; peak = Math.max(peak, running); await tick(); running--; return 1; };
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.get(`k${i}`, job)));
    expect(peak).toBe(2);
  });

  it("does not cache failures", async () => {
    const c = new QueryCache(60_000, 100, 4, true);
    await expect(c.get("k", async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
    expect(await c.get("k", async () => 7)).toBe(7);
  });

  it("keys ignore param order and empty values", () => {
    expect(paramsKey("count", { a: "1", b: undefined, c: "" , d: "x" })).toBe(paramsKey("count", { d: "x", a: "1" }));
  });
});
