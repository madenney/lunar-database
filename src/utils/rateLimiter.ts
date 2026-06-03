import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";

/**
 * Extract the real per-visitor IP. Behind the Cloudflare tunnel, req.ip is always
 * the tunnel's address (every request looks identical), which would collapse all
 * users into one shared rate-limit bucket. Cloudflare sets CF-Connecting-IP to the
 * original visitor IP, so prefer that; fall back to req.ip for direct/local requests.
 */
export function cfKeyGenerator(req: Request): string {
  return (req.headers["cf-connecting-ip"] as string) || req.ip || "unknown";
}

/** Create a rate limiter with CF-aware key generator. No-op in test. */
export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  message?: string | object;
}) {
  if (process.env.NODE_ENV === "test") {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: cfKeyGenerator,
    validate: { keyGeneratorIpFallback: false },
    message: opts.message,
  });
}
