import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { isTokenBlacklisted } from "../services/tokenBlacklist";

export interface AdminPayload {
  adminId: string;
  username: string;
  jti?: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminPayload;
    }
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AdminPayload;

    // Check if this token has been revoked (logout)
    if (payload.jti && await isTokenBlacklisted(payload.jti)) {
      res.status(401).json({ error: "Token has been revoked" });
      return;
    }

    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
