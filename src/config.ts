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

  // Job settings
  jobMaxReplays: parseInt(process.env.JOB_MAX_REPLAYS || "5000", 10),
  jobBundleExpiryHours: parseInt(process.env.JOB_BUNDLE_EXPIRY_HOURS || "48", 10),
  jobTempDir: process.env.JOB_TEMP_DIR || "/tmp/lm-job-temp",

  // Estimate settings
  estimateUploadSpeedMbps: parseInt(process.env.ESTIMATE_UPLOAD_SPEED_MBPS || "10", 10),
};
