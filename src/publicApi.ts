import type { Request, Response } from "express";
import type { CorsOptions, CorsOptionsDelegate } from "cors";
import { config } from "./config";
import spec from "./vendor/public-api/openapi.json";

/**
 * The public API (docs: packages/public-api, rendered at lunarmelee.com/developers).
 *
 * Browsers on any site may read it: nothing in it uses cookies, and limits are per
 * caller IP. Admin and submission routes stay limited to the website's origins.
 */
const SITE_ORIGINS = [
  "https://lunarmelee.com",
  "https://www.lunarmelee.com",
  ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000", "http://localhost:3001"] : []),
];
const PRIVATE_PREFIXES = ["/api/admin", "/api/submissions"];
/** Headers a browser client may read: limits, retry hints and download names. */
const EXPOSED = ["RateLimit-Policy", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After", "Content-Disposition"];

export const corsFor: CorsOptionsDelegate<Request> = (req, done) => {
  const isPrivate = PRIVATE_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`));
  const options: CorsOptions = isPrivate
    ? { origin: SITE_ORIGINS }
    : { origin: "*", exposedHeaders: EXPOSED, maxAge: 86400 };
  done(null, options);
};

/** GET /openapi.json — the machine-readable spec (OpenAPI 3.1). */
export function openApiSpec(_req: Request, res: Response): void {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json(spec);
}

/** GET / — where the docs are, for anyone who opens the API's address. */
export function apiIndex(_req: Request, res: Response): void {
  res.json({
    name: spec.info.title,
    version: spec.info.version,
    docs: `${config.publicSiteUrl}/developers`,
    openapi: "https://api.lunarmelee.com/openapi.json",
  });
}
