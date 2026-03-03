import mongoose from "mongoose";
import http from "http";
import { connectDb } from "../db";
import { config } from "../config";
import { Job } from "../models/Job";
import { fmt, heading, row } from "./fmt";

/** Check if the API server is responding */
function checkServer(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${config.port}/api/stats`, { timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  await connectDb();
  const serverUp = await checkServer();

  heading("Server");
  if (serverUp) {
    row("API", `\x1b[32mRunning\x1b[0m on port ${config.port}`);
    row("Workers", "Workers run inside the server process");
  } else {
    row("API", `\x1b[31mNot running\x1b[0m (port ${config.port})`);
    row("Workers", "\x1b[31mNot running\x1b[0m (server is down)");
  }

  // Infer worker activity from DB state
  heading("Worker Activity (from DB)");

  const compressingJobs = await Job.find({ status: { $in: ["processing", "compressing"] } })
    .select("status progress startedAt replayCount")
    .lean();

  if (compressingJobs.length > 0) {
    for (const j of compressingJobs) {
      const id = j._id.toString().slice(-6);
      const started = j.startedAt ? fmt.ago(j.startedAt) : "unknown";
      let detail = `[${j.status}]`;
      if (j.progress) {
        detail += ` ${j.progress.filesProcessed}/${j.progress.filesTotal} files`;
      }
      row("Compressor", `\x1b[32mWorking\x1b[0m ...${id} ${detail} started ${started}`);
    }
  } else {
    row("Compressor", "\x1b[90mIdle\x1b[0m (no jobs in processing/compressing)");
  }

  const uploadingJobs = await Job.find({ status: "uploading" })
    .select("status bundleSize startedAt")
    .lean();

  if (uploadingJobs.length > 0) {
    for (const j of uploadingJobs) {
      const id = j._id.toString().slice(-6);
      const size = j.bundleSize ? `${(j.bundleSize / 1024 / 1024).toFixed(1)} MB` : "?";
      row("Uploader", `\x1b[32mWorking\x1b[0m ...${id} uploading ${size}`);
    }
  } else {
    row("Uploader", "\x1b[90mIdle\x1b[0m (no jobs uploading)");
  }

  // Compressed jobs waiting for upload
  const waitingUpload = await Job.countDocuments({ status: "compressed" });
  if (waitingUpload > 0) {
    row("Upload queue", `${waitingUpload} compressed job(s) waiting`);
  }

  // Pending jobs
  const pendingCount = await Job.countDocuments({ status: "pending" });
  row("Pending queue", `${pendingCount} job(s)`);

  // Recent completions
  heading("Recent Completions");
  const recentDone = await Job.find({ status: "completed" })
    .select("completedAt bundleSize replayCount")
    .sort({ completedAt: -1 })
    .limit(5)
    .lean();

  if (recentDone.length > 0) {
    for (const j of recentDone) {
      const id = j._id.toString().slice(-6);
      const when = j.completedAt ? fmt.ago(j.completedAt) : "?";
      const size = j.bundleSize ? `${(j.bundleSize / 1024 / 1024).toFixed(1)} MB` : "?";
      const replays = j.replayCount ? `${j.replayCount} replays` : "";
      console.log(`  ...${id}  ${size}  ${replays}  completed ${when}`);
    }
  } else {
    console.log("  (none)");
  }

  console.log("");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
