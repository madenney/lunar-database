import { Response } from "express";

export function sendError(res: Response, err: unknown): void {
  console.error(err);
  if (process.env.NODE_ENV === "production") {
    res.status(500).json({ error: "Internal server error" });
  } else {
    res.status(500).json({ error: (err as Error).message });
  }
}
