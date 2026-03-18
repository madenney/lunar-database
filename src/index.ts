import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { cfKeyGenerator, createRateLimiter } from "./utils/rateLimiter";
import { connectDb } from "./db";
import { Job } from "./models/Job";
import { cleanupJobTemp, cleanupOrphanedTemp } from "./services/bundler";
import { startCompressor, stopCompressor } from "./workers/compressWorker";
import { startUploader, stopUploader } from "./workers/uploadWorker";
import { startCleanupWorker, stopCleanupWorker } from "./workers/cleanupWorker";
import replayRoutes from "./routes/replays";
import jobRoutes from "./routes/jobs";
import statsRoutes from "./routes/stats";
import playersRoutes from "./routes/players";
import referenceRoutes from "./routes/reference";
import submissionsRoutes from "./routes/submissions";
import adminRoutes from "./routes/admin";

async function recoverStaleJobs() {
  // processing/compressing → pending (start over, temp files are unreliable after crash)
  const staleCompressing = await Job.find({ status: { $in: ["processing", "compressing"] } });
  for (const job of staleCompressing) {
    const was = job.status;
    cleanupJobTemp(job._id.toString());
    job.status = "pending";
    job.startedAt = null;
    job.progress = null;
    job.error = null;
    await job.save();
    console.log(`Recovered stale job ${job._id} (was ${was}) → pending`);
  }

  // uploading → compressed if tar exists, else pending
  const staleUploading = await Job.find({ status: "uploading" });
  for (const job of staleUploading) {
    if (job.bundlePath && fs.existsSync(job.bundlePath)) {
      job.status = "compressed";
      job.progress = null;
      await job.save();
      console.log(`Recovered stale job ${job._id} (was uploading) → compressed`);
    } else {
      cleanupJobTemp(job._id.toString());
      job.status = "pending";
      job.startedAt = null;
      job.progress = null;
      job.bundlePath = null;
      job.bundleSize = null;
      await job.save();
      console.log(`Recovered stale job ${job._id} (was uploading, no bundle) → pending`);
    }
  }
}

async function main() {
  await connectDb();

  const app = express();

  // Trust first proxy (Cloudflare Tunnel)
  app.set("trust proxy", 1);

  // Security headers
  app.use(helmet());

  app.use(cors({
    origin: [
      "https://lunarmelee.com",
      "https://www.lunarmelee.com",
      ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000", "http://localhost:3001"] : []),
    ],
  }));
  app.use(express.json({ limit: "100kb" }));

  // Global rate limit: 100 requests per minute per IP
  app.use(createRateLimiter({ windowMs: 60 * 1000, max: 100 }));

  // Strict rate limit on login: 5 attempts per 15 minutes
  app.use("/api/admin/login", createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: "Too many login attempts, please try again later" },
  }));

  // Request logging
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path} [${req.ip}]`);
    next();
  });

  app.use("/api/replays", replayRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/players", playersRoutes);
  app.use("/api/reference", referenceRoutes);
  app.use("/api/submissions", submissionsRoutes);
  app.use("/api/admin", adminRoutes);

  // Health check
  app.get("/health", (_req, res) => res.json({ ok: true }));

  const server = app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });

  // Recover jobs left in intermediate states from a previous crash
  await recoverStaleJobs();

  // Clean up orphaned temp files from previous crashes (older than 24h)
  const orphansCleaned = await cleanupOrphanedTemp();
  if (orphansCleaned > 0) {
    console.log(`Cleaned ${orphansCleaned} orphaned temp entries`);
  }

  // Start job workers
  startCompressor();
  startUploader();
  startCleanupWorker();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down gracefully...`);

    stopCompressor();
    stopUploader();
    stopCleanupWorker();

    server.close(() => {
      console.log("HTTP server closed");
    });

    // Give workers a moment to finish their current poll cycle
    await new Promise((r) => setTimeout(r, 2000));

    console.log("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
