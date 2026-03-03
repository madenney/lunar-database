import { Response } from "express";

export function sendError(res: Response, err: unknown): void {
  console.error(err);
  const e = err as any;
  if (e?.name === "CastError") {
    res.status(400).json({ error: "Invalid ID format" });
    return;
  }
  if (process.env.NODE_ENV === "development") {
    res.status(500).json({ error: (err as Error).message });
  } else {
    res.status(500).json({ error: "Internal server error" });
  }
}
