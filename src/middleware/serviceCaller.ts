import { timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * Recognise the website, which calls this API on behalf of visitors, by the shared
 * LUNAR_SERVICE_KEY (sent as X-Lunar-Service-Key). Only the website may:
 *   - speak for a visitor: X-Visitor-Ip keys rate limits per visitor, since every
 *     website request otherwise arrives from the website's own address; and
 *   - claim an identity: once a key is configured, X-Client-Id from any other
 *     caller is dropped, so job ownership can't be forged by calling this API
 *     directly with a guessed client id.
 * With no key configured this is a no-op, preserving the old behaviour.
 */
export function identifyServiceCaller(req: Request, _res: Response, next: NextFunction): void {
  const key = config.serviceKey;
  const sent = req.headers["x-lunar-service-key"];
  const trusted = !!key && typeof sent === "string" && safeEqual(sent, key);
  callerState(req).serviceCaller = trusted;
  if (key && !trusted) {
    delete req.headers["x-client-id"];
    delete req.headers["x-visitor-ip"];
  }
  next();
}

/** Whether this request came from the website (see identifyServiceCaller). */
export function isServiceCaller(req: Request): boolean {
  return callerState(req).serviceCaller === true;
}

/** The visitor IP the website forwarded, if this is a trusted website request. */
export function forwardedVisitorIp(req: Request): string | undefined {
  if (!isServiceCaller(req)) return undefined;
  const ip = req.headers["x-visitor-ip"];
  return typeof ip === "string" && VISITOR_IP_RE.test(ip) ? ip : undefined;
}

// IPv4 / IPv6 characters only, bounded, so the value is safe as a limiter key.
const VISITOR_IP_RE = /^[0-9a-fA-F:.]{2,64}$/;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function callerState(req: Request): { serviceCaller?: boolean } {
  return ((req as any).lunar ??= {});
}
