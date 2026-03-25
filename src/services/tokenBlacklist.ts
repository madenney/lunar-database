import mongoose, { Schema, Document } from "mongoose";

interface IBlacklistedToken extends Document {
  jti: string;
  expiresAt: Date;
}

const BlacklistedTokenSchema = new Schema<IBlacklistedToken>({
  jti: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});

// Auto-delete expired entries so the collection stays small
BlacklistedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const BlacklistedToken = mongoose.model<IBlacklistedToken>("BlacklistedToken", BlacklistedTokenSchema);

// In-memory cache to avoid DB lookups on every request
const memoryCache = new Set<string>();

/** Add a token's JTI to the blacklist. */
export async function blacklistToken(jti: string, expiresAt: Date): Promise<void> {
  memoryCache.add(jti);
  await BlacklistedToken.create({ jti, expiresAt }).catch(() => {});
}

/** Check if a token's JTI is blacklisted. */
export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  if (memoryCache.has(jti)) return true;
  const found = await BlacklistedToken.exists({ jti });
  if (found) memoryCache.add(jti);
  return !!found;
}
