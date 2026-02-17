import { Router, Request, Response } from "express";
import { Job, IJobFilter } from "../models/Job";
import { Replay } from "../models/Replay";
import { buildReplayQuery } from "../services/replayQuery";
import { config } from "../config";

const router = Router();

function parseFilter(body: Record<string, any>): IJobFilter {
  const { connectCode, characterId, stageId, startDate, endDate } = body;
  return {
    connectCode: connectCode || undefined,
    characterId: characterId != null ? Number(characterId) : undefined,
    stageId: stageId != null ? Number(stageId) : undefined,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
  };
}

function hasAtLeastOneFilter(filter: IJobFilter): boolean {
  return !!(filter.connectCode || filter.characterId != null || filter.stageId != null || filter.startDate || filter.endDate);
}

// POST /api/jobs/estimate — estimate replay count and size for a filter
router.post("/estimate", async (req: Request, res: Response) => {
  try {
    const filter = parseFilter(req.body);

    if (!hasAtLeastOneFilter(filter)) {
      res.status(400).json({ error: "At least one filter is required" });
      return;
    }

    const query = buildReplayQuery(filter);

    const [count, sizeAgg] = await Promise.all([
      Replay.countDocuments(query),
      Replay.aggregate([
        { $match: query },
        { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
      ]),
    ]);

    const rawSize = sizeAgg[0]?.totalSize ?? 0;
    // slpz typically achieves 8-12x compression; estimate conservatively at 8x
    const estimatedCompressedSize = Math.round(rawSize / 8);

    res.json({
      replayCount: count,
      rawSize,
      estimatedCompressedSize,
      exceedsLimit: count > config.jobMaxReplays,
      limit: config.jobMaxReplays,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/jobs — create a download job
router.post("/", async (req: Request, res: Response) => {
  try {
    const filter = parseFilter(req.body);

    if (!hasAtLeastOneFilter(filter)) {
      res.status(400).json({ error: "At least one filter is required" });
      return;
    }

    // Pre-check count
    const query = buildReplayQuery(filter);
    const count = await Replay.countDocuments(query);

    if (count === 0) {
      res.status(400).json({ error: "No replays match this filter" });
      return;
    }

    if (count > config.jobMaxReplays) {
      res.status(400).json({
        error: `Filter matches ${count} replays, exceeding the limit of ${config.jobMaxReplays}. Narrow your filter.`,
      });
      return;
    }

    const job = await Job.create({ filter });

    res.status(201).json({ jobId: job._id, status: job.status });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/jobs/:id — check job status
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Lazily mark expired jobs
    if (job.status === "completed" && job.expiresAt && job.expiresAt <= new Date()) {
      job.status = "expired";
      job.downloadUrl = null;
      await job.save();
    }

    res.json({
      jobId: job._id,
      status: job.status,
      replayCount: job.replayCount,
      estimatedSize: job.estimatedSize,
      bundleSize: job.bundleSize,
      downloadUrl: job.downloadUrl,
      expiresAt: job.expiresAt,
      progress: job.progress,
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/jobs/:id/download — redirect to presigned R2 URL
router.get("/:id/download", async (req: Request, res: Response) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status === "expired" || (job.expiresAt && job.expiresAt <= new Date())) {
      res.status(410).json({ error: "Download has expired" });
      return;
    }

    if (job.status !== "completed" || !job.downloadUrl) {
      res.status(400).json({ error: "Bundle not ready" });
      return;
    }

    res.redirect(job.downloadUrl);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
