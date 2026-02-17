import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import { Replay } from "../models/Replay";
import { Job } from "../models/Job";

const router = Router();

// GET /api/stats — overview stats
router.get("/", async (_req: Request, res: Response) => {
  try {
    // Exclude junk replays: must have a known stage or at least one known character
    const notJunk = {
      $or: [
        { stageId: { $ne: null } },
        { "players.characterId": { $ne: null } },
      ],
      "players.0": { $exists: true },
    };

    const [replayCount, jobCounts, dbStats, totalSizeAgg] = await Promise.all([
      Replay.countDocuments(notJunk),
      Job.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      mongoose.connection.db!.stats(),
      Replay.aggregate([
        { $match: notJunk },
        { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
      ]),
    ]);

    const jobs: Record<string, number> = {};
    for (const entry of jobCounts) {
      jobs[entry._id] = entry.count;
    }

    res.json({
      replays: replayCount,
      jobs,
      dbSizeBytes: dbStats.dataSize,
      totalFileSizeBytes: totalSizeAgg[0]?.totalSize ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
