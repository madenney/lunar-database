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
  jobMaxPendingTotal: parseInt(process.env.JOB_MAX_PENDING_TOTAL || "200", 10),
  // Launch-load shaping (services/jobQueue.ts). Bundles estimated at or under
  // fastLaneMaxMb also go to a second worker pair, so a huge job never blocks
  // small ones. jobMaxBundleMb can cap a single job (off by default: bundles
  // stream straight to storage, so any size works). An identical request within jobReuseHours joins
  // the existing job or gets its finished bundle instead of building another.
  // 200 MB: at 1 GB, three ~1 GB requests filled the fast lane in the download-rush
  // test and a 13-game bundle waited behind them.
  fastLaneMaxMb: parseInt(process.env.JOB_FAST_LANE_MAX_MB || "200", 10),
  /** 0 = no limit (the default since bundles stream straight to storage). */
  jobMaxBundleMb: parseInt(process.env.JOB_MAX_BUNDLE_MB || "0", 10),
  jobReuseHours: parseInt(process.env.JOB_REUSE_HOURS || "48", 10),
  /** Upload retries for transient network/TLS errors before a job fails. */
  jobUploadMaxAttempts: parseInt(process.env.JOB_UPLOAD_MAX_ATTEMPTS || "3", 10),
  /** Alert when bundle bytes uploaded + downloaded in 24 h pass this (0 = off). Early warning before the storage provider's daily caps. */
  storageDailyAlertGb: parseInt(process.env.STORAGE_DAILY_ALERT_GB || "0", 10),
  /** How long search counts and size estimates are reused (services/queryCache.ts). */
  queryCacheSeconds: parseInt(process.env.QUERY_CACHE_SECONDS || "600", 10),
  /** Most count/estimate scans MongoDB runs at once; more queue (load test: >20 = timeouts). */
  queryMaxHeavy: parseInt(process.env.QUERY_MAX_HEAVY || "6", 10),
  /** Stop counting here and report "N+" (0 = always exact, the default: the user wants real totals). */
  countCap: parseInt(process.env.COUNT_CAP || "0", 10),
  // Concurrent replay downloads over the server's uplink (services/replayStreams.ts);
  // the rest wait up to replayStreamWaitMs, then get 503 storage_busy.
  replayStreamsMax: parseInt(process.env.REPLAY_STREAMS_MAX || "8", 10),
  replayStreamWaitMs: parseInt(process.env.REPLAY_STREAM_WAIT_MS || "15000", 10),
  // Heavy bytes per second over the server's uplink, shared by replay downloads and
  // bundle uploads (services/uplink.ts): ~40 Mbit of the ~53, so searches and pages
  // always keep the rest. REPLAY_BYTES_PER_SEC is the older name for it.
  uplinkBytesPerSec: parseInt(process.env.UPLINK_BYTES_PER_SEC || process.env.REPLAY_BYTES_PER_SEC || "5000000", 10),

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

  // Stuck-job reaper (M5). A live worker whose current job wedges won't hit the
  // in-process timeout (that only fires between operations), so a periodic reaper,
  // independent of the worker loop, fails jobs stuck in an active state too long.
  // It times each phase (compression, upload) separately, so jobStuckAfterMinutes
  // must be >= jobTimeoutMinutes; the 2x default leaves room for operations that
  // overrun the in-process timeout check. Crash-orphaned jobs are handled separately by
  // recoverStaleJobs() at startup.
  jobReaperIntervalMinutes: parseInt(process.env.JOB_REAPER_INTERVAL_MINUTES || "15", 10),
  jobStuckAfterMinutes: parseInt(process.env.JOB_STUCK_AFTER_MINUTES || "960", 10),
  slpzBinary: process.env.SLPZ_BINARY || "/usr/local/bin/slpz",

  // Per-game event files written by the stats extraction (scripts/extractStats.ts
  // --detail-dir). Read by GET /api/replays/:id/stats; empty = events unavailable.
  statsDetailDir: process.env.STATS_DETAIL_DIR || "",
  /** Shared secret identifying the website (see middleware/serviceCaller.ts).
   *  Empty = no website trust: rate limits key on the connecting IP and any
   *  caller's X-Client-Id is accepted, as before. */
  serviceKey: process.env.LUNAR_SERVICE_KEY || "",
  // The website, where the public developer docs live and where a direct API
  // caller's replay download is sent (served from storage, cached at the edge).
  publicSiteUrl: (process.env.PUBLIC_SITE_URL || "https://lunarmelee.com").replace(/\/$/, ""),
  slpzTimeoutMinutes: parseInt(process.env.SLPZ_TIMEOUT_MINUTES || "30", 10),
  minFreeDiskMb: parseInt(process.env.MIN_FREE_DISK_MB || "2048", 10),

  // Estimate settings
  estimateUploadSpeedMbps: parseInt(process.env.ESTIMATE_UPLOAD_SPEED_MBPS || "10", 10),

  // Storage cleanup: expired job bundles are deleted from storage and forgotten
  // (a bucket lifecycle rule on jobs/ is the safety net)
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
