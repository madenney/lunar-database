import { Response } from "express";

export function sendError(res: Response, err: unknown): void {
  console.error((err as Error)?.message || err);
  const e = err as any;
  if (e?.name === "CastError") {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  // Always return generic error to clients — never leak internal details
  res.status(500).json({ error: "Internal server error" });
}
