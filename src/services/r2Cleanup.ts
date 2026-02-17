import { Job } from "../models/Job";
import { deleteFromR2 } from "./r2";

export async function cleanupExpiredR2Bundles(): Promise<number> {
  const now = new Date();

  const expiredJobs = await Job.find({
    status: "completed",
    expiresAt: { $lte: now },
    r2Key: { $ne: null },
  });

  let cleaned = 0;

  for (const job of expiredJobs) {
    try {
      await deleteFromR2(job.r2Key!);
      job.status = "expired";
      job.downloadUrl = null;
      await job.save();
      cleaned++;
      console.log(`Expired job ${job._id}, deleted R2 key ${job.r2Key}`);
    } catch (err) {
      console.error(`Failed to expire job ${job._id}:`, (err as Error).message);
    }
  }

  return cleaned;
}
