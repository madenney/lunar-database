import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AdminPayload {
  adminId: string;
  username: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminPayload;
    }
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AdminPayload;
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
