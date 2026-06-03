import { Request, Response, NextFunction } from "express";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate X-Client-Id header if present.
 * Rejects requests with malformed client IDs to prevent NoSQL injection.
 * Does NOT require the header — only validates format when present.
 */
export function validateClientId(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers["x-client-id"];
  if (raw !== undefined) {
    if (typeof raw !== "string" || !UUID_RE.test(raw)) {
      res.status(400).json({ error: "Invalid X-Client-Id format (must be UUID)" });
      return;
    }
  }
  next();
}
