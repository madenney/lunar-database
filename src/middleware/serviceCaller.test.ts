import type { Request } from "express";
import { config } from "../config";
import { identifyServiceCaller, isServiceCaller, forwardedVisitorIp } from "./serviceCaller";
import { cfKeyGenerator } from "../utils/rateLimiter";

const CLIENT = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

function run(headers: Record<string, string>, ip = "10.0.0.1"): Request {
  const req = { headers: { ...headers }, ip } as unknown as Request;
  identifyServiceCaller(req, {} as any, () => {});
  return req;
}

describe("identifyServiceCaller", () => {
  const original = config.serviceKey;
  afterEach(() => { config.serviceKey = original; });

  describe("with a service key configured", () => {
    beforeEach(() => { config.serviceKey = "s3cret"; });

    it("trusts the website and keys limits on the forwarded visitor", () => {
      const req = run({ "x-lunar-service-key": "s3cret", "x-visitor-ip": "203.0.113.7", "x-client-id": CLIENT });
      expect(isServiceCaller(req)).toBe(true);
      expect(forwardedVisitorIp(req)).toBe("203.0.113.7");
      expect(cfKeyGenerator(req)).toBe("203.0.113.7");
      expect(req.headers["x-client-id"]).toBe(CLIENT);
    });

    it("drops identity headers from anyone else", () => {
      const req = run(
        { "x-lunar-service-key": "wrong", "x-visitor-ip": "203.0.113.7", "x-client-id": CLIENT, "cf-connecting-ip": "198.51.100.2" },
      );
      expect(isServiceCaller(req)).toBe(false);
      expect(req.headers["x-client-id"]).toBeUndefined();
      expect(forwardedVisitorIp(req)).toBeUndefined();
      expect(cfKeyGenerator(req)).toBe("198.51.100.2");
    });

    it("ignores a malformed visitor IP", () => {
      const req = run({ "x-lunar-service-key": "s3cret", "x-visitor-ip": "not an ip!" });
      expect(forwardedVisitorIp(req)).toBeUndefined();
      expect(cfKeyGenerator(req)).toBe("10.0.0.1");
    });
  });

  describe("without a service key", () => {
    beforeEach(() => { config.serviceKey = ""; });

    it("keeps the old behaviour: client ids pass, forwarded IPs are ignored", () => {
      const req = run({ "x-lunar-service-key": "", "x-visitor-ip": "203.0.113.7", "x-client-id": CLIENT });
      expect(isServiceCaller(req)).toBe(false);
      expect(req.headers["x-client-id"]).toBe(CLIENT);
      expect(cfKeyGenerator(req)).toBe("10.0.0.1");
    });
  });
});
