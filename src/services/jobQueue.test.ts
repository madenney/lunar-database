import { filterKey, laneFor, simulateQueue, type IJobLike } from "./jobQueue";

const MB = 1024 * 1024;
const job = (id: string, mb: number, at: number, extra: Partial<IJobLike> = {}): IJobLike => ({
  _id: id,
  status: "pending",
  bundleSize: mb * MB,
  estimatedSize: null,
  replayCount: 0,
  progress: null,
  createdAt: new Date(at * 1000),
  priority: 0,
  lane: laneFor(mb * MB),
  ...extra,
});

describe("filterKey", () => {
  it("ignores list order and a sort that doesn't pick anything", () => {
    expect(filterKey({ p1CharacterId: "9,2", stageId: "31" })).toBe(filterKey({ stageId: "31", p1CharacterId: "2,9", sort: "startAt:-1" }));
  });
  it("keeps the sort when a limit makes it choose which games", () => {
    expect(filterKey({ stageId: "31", maxFiles: 10, sort: "startAt:1" })).not.toBe(filterKey({ stageId: "31", maxFiles: 10, sort: "startAt:-1" }));
  });
  it("tells different filters apart", () => {
    expect(filterKey({ p1ConnectCode: "A#1" })).not.toBe(filterKey({ p2ConnectCode: "A#1" }));
  });
});

describe("simulateQueue", () => {
  const bps = 1 * MB; // 1 MB/s

  it("runs a waiting job after the one ahead of it", () => {
    const f = simulateQueue([], [job("a", 3000, 1), job("b", 2000, 2)], bps);
    expect(f.get("a")).toEqual({ startSec: 0, readySec: 3000, ahead: 0 });
    expect(f.get("b")).toEqual({ startSec: 3000, readySec: 5000, ahead: 1 });
  });

  it("doesn't make a small job wait behind a huge one", () => {
    const f = simulateQueue([job("huge", 60000, 0, { status: "uploading" })], [job("big", 5000, 1), job("small", 10, 2)], bps);
    expect(f.get("small")!.startSec).toBe(0);
    expect(f.get("small")!.readySec).toBe(20); // shares the uplink with the huge job
    expect(f.get("big")!.startSec).toBeGreaterThan(50000);
  });
});
