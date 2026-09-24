import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { API_ERROR_CODES } from "./apiErrors";
import { forwardedVisitorIp, isServiceCaller } from "../middleware/serviceCaller";

/**
 * The real per-visitor IP. Most traffic is the website calling on a visitor's
 * behalf, so every such request arrives from the website's own address; the
 * website forwards the visitor's IP (trusted only with the service key, see
 * serviceCaller.ts). Direct callers come through the Cloudflare tunnel, where
 * req.ip is always the tunnel and CF-Connecting-IP holds the caller's address.
 */
export function cfKeyGenerator(req: Request): string {
  return forwardedVisitorIp(req) || (req.headers["cf-connecting-ip"] as string) || req.ip || "unknown";
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
    // The website's own calls (stats, page rendering) carry no visitor; it rate
    // limits its routes itself, so don't lump every visitor into its address.
    skip: (req) => isServiceCaller(req) && !forwardedVisitorIp(req),
    validate: { keyGeneratorIpFallback: false },
    // Always JSON with the rate_limited code, whatever message a route supplies.
    message: {
      ...(typeof opts.message === "object" ? opts.message : { error: opts.message ?? API_ERROR_CODES.rate_limited }),
      code: "rate_limited",
    },
  });
}
