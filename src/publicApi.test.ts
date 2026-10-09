import express from "express";
import cors from "cors";
import http from "http";
import { apiIndex, corsFor, openApiSpec } from "./publicApi";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(cors(corsFor));
  app.get("/openapi.json", openApiSpec);
  app.get("/", apiIndex);
  app.get("/api/replays", (_req, res) => res.json({ ok: true }));
  app.get("/api/admin/stats", (_req, res) => res.json({ ok: true }));
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("public API surface", () => {
  it("lets any site read public routes, and only the website read admin ones", async () => {
    const pub = await fetch(`${base}/api/replays`, { headers: { Origin: "https://someones-tool.example" } });
    expect(pub.headers.get("access-control-allow-origin")).toBe("*");
    expect(pub.headers.get("access-control-expose-headers")).toContain("Retry-After");
    const admin = await fetch(`${base}/api/admin/stats`, { headers: { Origin: "https://someones-tool.example" } });
    expect(admin.headers.get("access-control-allow-origin")).toBeNull();
    const site = await fetch(`${base}/api/admin/stats`, { headers: { Origin: "https://lunarmelee.com" } });
    expect(site.headers.get("access-control-allow-origin")).toBe("https://lunarmelee.com");
  });

  it("serves the spec and points at the docs", async () => {
    const spec: any = await (await fetch(`${base}/openapi.json`)).json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/api/replays"].get.operationId).toBe("searchReplays");
    const index = await (await fetch(`${base}/`)).json();
    expect(index).toMatchObject({ name: "Lunar Melee API", docs: "https://lunarmelee.com/developers" });
  });
});
