import { createHash, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * Recognise the website, which calls this API on behalf of visitors, by the shared
 * LUNAR_SERVICE_KEY (sent as X-Lunar-Service-Key). Only the website may:
 *   - speak for a visitor: X-Visitor-Ip keys rate limits per visitor, since every
 *     website request otherwise arrives from the website's own address; and
 *   - claim a website identity: once a key is configured, X-Client-Id from any
 *     other caller is moved into its own namespace (publicClientId), so a direct
 *     API caller can own jobs but can never reach a website visitor's jobs by
 *     guessing their id.
 * With no key configured this is a no-op, preserving the old behaviour.
 */
export function identifyServiceCaller(req: Request, _res: Response, next: NextFunction): void {
  const key = config.serviceKey;
  const sent = req.headers["x-lunar-service-key"];
  const trusted = !!key && typeof sent === "string" && safeEqual(sent, key);
  callerState(req).serviceCaller = trusted;
  if (key && !trusted) {
    const id = req.headers["x-client-id"];
    // A malformed id is left as is: validateClientId answers 400 invalid_client.
    if (typeof id === "string" && UUID_RE.test(id)) req.headers["x-client-id"] = publicClientId(id);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A direct API caller's X-Client-Id, as stored: a UUID derived from theirs, in a
 * namespace website ids (derived from emails and IPs) never land in. The same
 * caller id always maps to the same stored id, so their jobs stay theirs.
 */
export function publicClientId(id: string): string {
  const h = createHash("sha256").update(`lunar-public-api:${id.toLowerCase()}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
