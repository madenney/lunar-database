import express from "express";
import cors from "cors";
import { config } from "./config";
import { connectDb } from "./db";
import { startWorker } from "./workers/jobWorker";
import { cleanupExpiredR2Bundles } from "./services/r2Cleanup";
import replayRoutes from "./routes/replays";
import jobRoutes from "./routes/jobs";
import statsRoutes from "./routes/stats";
import playersRoutes from "./routes/players";
import referenceRoutes from "./routes/reference";
import submissionsRoutes from "./routes/submissions";

async function main() {
  await connectDb();

  const app = express();
  app.use(cors({
    origin: [
      "https://lunarmelee.com",
      "https://www.lunarmelee.com",
      ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000", "http://localhost:3001"] : []),
    ],
  }));
  app.use(express.json());

  app.use("/api/replays", replayRoutes);
  app.use("/api/jobs", jobRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/players", playersRoutes);
  app.use("/api/reference", referenceRoutes);
  app.use("/api/submissions", submissionsRoutes);

  // Health check
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });

  // Start job worker
  startWorker();

  // Periodic R2 bundle cleanup (every hour)
  setInterval(async () => {
    try {
      const cleaned = await cleanupExpiredR2Bundles();
      if (cleaned > 0) console.log(`Expired ${cleaned} R2 bundles`);
    } catch (err) {
      console.error("R2 cleanup error:", (err as Error).message);
    }
  }, 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
