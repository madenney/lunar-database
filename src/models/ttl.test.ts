import { SearchEvent } from "./SearchEvent";
import { DownloadEvent } from "./DownloadEvent";
import { config } from "../config";

// M3: analytics events must carry a TTL so searched connect codes / display names
// and clientIds don't persist forever.
describe("analytics-event TTL indexes (M3)", () => {
  function createdAtTtl(model: any): number | undefined {
    const entry = model.schema
      .indexes()
      .find(([keys]: any) => keys && keys.createdAt === 1 && Object.keys(keys).length === 1);
    return entry?.[1]?.expireAfterSeconds;
  }

  it("SearchEvent createdAt expires after the retention window", () => {
    expect(createdAtTtl(SearchEvent)).toBe(config.analyticsRetentionDays * 24 * 60 * 60);
  });

  it("DownloadEvent createdAt TTL stays above the full-DB throttle window", () => {
    const ttl = createdAtTtl(DownloadEvent);
    expect(ttl).toBeGreaterThan(config.fullDbWindowHours * 60 * 60);
    expect(ttl).toBe(
      Math.max(config.analyticsRetentionDays * 24 * 60 * 60, (config.fullDbWindowHours + 24) * 60 * 60)
    );
  });
});
