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

// In-memory cache to avoid DB lookups on every request.
// Stores jti → expiry timestamp so we can prune expired entries.
const memoryCache = new Map<string, number>();

/** Prune expired entries from memory cache. Runs periodically. */
function pruneCache(): void {
  const now = Date.now();
  for (const [jti, expiresMs] of memoryCache) {
    if (expiresMs <= now) memoryCache.delete(jti);
  }
}

// Prune every 10 minutes
setInterval(pruneCache, 10 * 60 * 1000).unref();

/** Add a token's JTI to the blacklist. */
export async function blacklistToken(jti: string, expiresAt: Date): Promise<void> {
  memoryCache.set(jti, expiresAt.getTime());
  await BlacklistedToken.create({ jti, expiresAt }).catch(() => {});
}

/** Check if a token's JTI is blacklisted. */
export async function isTokenBlacklisted(jti: string): Promise<boolean> {
  const cached = memoryCache.get(jti);
  if (cached !== undefined) {
    if (cached > Date.now()) return true;
    memoryCache.delete(jti); // expired, clean up
    return false;
  }
  const found = await BlacklistedToken.exists({ jti });
  if (found) {
    // Cache with a generous TTL — MongoDB TTL index handles actual cleanup
    memoryCache.set(jti, Date.now() + 24 * 60 * 60 * 1000);
  }
  return !!found;
}

/** Preload active blacklist entries into memory on startup. */
export async function preloadBlacklist(): Promise<void> {
  const entries = await BlacklistedToken.find({ expiresAt: { $gt: new Date() } }).select("jti").lean();
  for (const entry of entries) {
    memoryCache.set(entry.jti, new Date(entry.expiresAt).getTime());
  }
  if (entries.length > 0) {
    console.log(`Preloaded ${entries.length} blacklisted tokens into memory`);
  }
}
