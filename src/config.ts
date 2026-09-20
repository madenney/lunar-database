import dotenv from "dotenv";
dotenv.config();

export const config = {
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/lm-database",
  port: parseInt(process.env.PORT || "3000", 10),
  slpRootDir: process.env.SLP_ROOT_DIR || "/data/slp",
  airlockDir: process.env.AIRLOCK_DIR || "/data/airlock",

  // Persistent cache of pre-compressed .slpz files, mirroring SLP_ROOT_DIR's
  // directory layout. Bundles reuse these instead of recompressing raw .slp on
  // every download. Populated lazily by the bundler and in bulk by compressAll.ts.
  slpzArchiveDir: process.env.SLPZ_ARCHIVE_DIR || "/home/matt/Projects/worker/lunar_db/slpz",

  // S3-compatible storage (Backblaze B2)
  s3Endpoint: process.env.S3_ENDPOINT || "",
  s3Region: process.env.S3_REGION || "us-west-004",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  s3BucketName: process.env.S3_BUCKET_NAME || "lm-replays",
  get s3Configured(): boolean {
    return !!(this.s3Endpoint && this.s3AccessKeyId && this.s3SecretAccessKey);
  },

  // Job settings
  jobTempDir: process.env.JOB_TEMP_DIR || "/var/lib/lm-database/temp",
  jobMaxConcurrentPerClient: parseInt(process.env.JOB_MAX_CONCURRENT_PER_CLIENT || "3", 10),
  jobMaxPendingTotal: parseInt(process.env.JOB_MAX_PENDING_TOTAL || "50", 10),

  // Full-DB download throttle. The full-DB bundle is ~1.3 TB — a handful of pulls
  // dominate all B2 egress (one client pulled it 4× in a day, almost certainly
  // failed-download retries). Cap issuances of the full-DB presigned URL per client
  // per rolling window so one person can't burn multiple TB of egress in an
  // afternoon. Only applies to isFullDb bundles; normal job/replay downloads are
  // untouched. Set FULLDB_MAX_PER_WINDOW=0 to disable.
  fullDbMaxPerWindow: parseInt(process.env.FULLDB_MAX_PER_WINDOW || "2", 10),
  fullDbWindowHours: parseInt(process.env.FULLDB_WINDOW_HOURS || "24", 10),

  // Worker safety limits
  jobTimeoutMinutes: parseInt(process.env.JOB_TIMEOUT_MINUTES || "480", 10),
  slpzBinary: process.env.SLPZ_BINARY || "/usr/local/bin/slpz",
  slpzTimeoutMinutes: parseInt(process.env.SLPZ_TIMEOUT_MINUTES || "30", 10),
  minFreeDiskMb: parseInt(process.env.MIN_FREE_DISK_MB || "2048", 10),

  // Estimate settings
  estimateUploadSpeedMbps: parseInt(process.env.ESTIMATE_UPLOAD_SPEED_MBPS || "10", 10),

  // Storage cleanup (DB-only — B2 lifecycle rules handle object expiry)
  storageCleanupAfterDays: parseInt(process.env.STORAGE_CLEANUP_AFTER_DAYS || "3", 10),
  storageCleanupIntervalMinutes: parseInt(process.env.STORAGE_CLEANUP_INTERVAL_MINUTES || "60", 10),

  // Analytics-event PII retention. SearchEvent stores searched connect codes /
  // display names + clientId; DownloadEvent stores clientId. A TTL index expires
  // these after this window so we don't hold behavioral PII forever (security
  // review M3). 180d bounds it to a rolling 6 months while keeping analytics
  // useful; lower it for stricter privacy. NOTE: the DownloadEvent TTL is floored
  // above the full-DB throttle window (see models/DownloadEvent.ts) so expiry
  // never deletes rows the throttle still needs to count.
  analyticsRetentionDays: parseInt(process.env.ANALYTICS_RETENTION_DAYS || "180", 10),

  // Alerts
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || "",
  alertEmailFrom: process.env.ALERT_EMAIL_FROM || "",
  alertEmailTo: process.env.ALERT_EMAIL_TO || "",

  // Auth
  get jwtSecret(): string {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    throw new Error("JWT_SECRET environment variable is required");
  },
  jwtExpiresIn: (process.env.JWT_EXPIRES_IN || "2h") as import("ms").StringValue,
};
