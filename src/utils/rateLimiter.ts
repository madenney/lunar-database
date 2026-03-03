import { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";

/** Extract real client IP — prefer req.ip (trust proxy aware), fall back to CF header */
export function cfKeyGenerator(req: Request): string {
  return req.ip || (req.headers["cf-connecting-ip"] as string) || "unknown";
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
