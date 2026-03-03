import dotenv from "dotenv";
dotenv.config();

export const config = {
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/lm-database",
  port: parseInt(process.env.PORT || "3000", 10),
  slpRootDir: process.env.SLP_ROOT_DIR || "/data/slp",
  bundlesDir: process.env.BUNDLES_DIR || "/data/bundles",
  bundleMaxAgeHours: parseInt(process.env.BUNDLE_MAX_AGE_HOURS || "72", 10),
  crawlerBatchSize: parseInt(process.env.CRAWLER_BATCH_SIZE || "100", 10),
  airlockDir: process.env.AIRLOCK_DIR || "/data/airlock",

  // R2 / S3 storage
  r2AccountId: process.env.R2_ACCOUNT_ID || "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  r2BucketName: process.env.R2_BUCKET_NAME || "lm-replays",
  get r2Configured(): boolean {
    return !!(this.r2AccountId && this.r2AccessKeyId && this.r2SecretAccessKey);
  },

  // Job settings
  jobBundleExpiryHours: parseInt(process.env.JOB_BUNDLE_EXPIRY_HOURS || "48", 10),
  jobTempDir: process.env.JOB_TEMP_DIR || "/tmp/lm-job-temp",
  jobMaxConcurrentPerClient: parseInt(process.env.JOB_MAX_CONCURRENT_PER_CLIENT || "3", 10),
  jobMaxPendingTotal: parseInt(process.env.JOB_MAX_PENDING_TOTAL || "50", 10),

  // Worker safety limits
  jobTimeoutMinutes: parseInt(process.env.JOB_TIMEOUT_MINUTES || "60", 10),
  slpzTimeoutMinutes: parseInt(process.env.SLPZ_TIMEOUT_MINUTES || "30", 10),
  minFreeDiskMb: parseInt(process.env.MIN_FREE_DISK_MB || "2048", 10),

  // Estimate settings
  estimateUploadSpeedMbps: parseInt(process.env.ESTIMATE_UPLOAD_SPEED_MBPS || "10", 10),

  // R2 cleanup
  r2CleanupAfterDays: parseInt(process.env.R2_CLEANUP_AFTER_DAYS || "30", 10),
  r2CleanupIntervalMinutes: parseInt(process.env.R2_CLEANUP_INTERVAL_MINUTES || "60", 10),

  // Auth
  get jwtSecret(): string {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    throw new Error("JWT_SECRET environment variable is required");
  },
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "24h",
};
