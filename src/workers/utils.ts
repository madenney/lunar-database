import { Job } from "../models/Job";

export async function isCancelled(jobId: string): Promise<boolean> {
  const job = await Job.findById(jobId).select("status").lean();
  return !job || job.status === "cancelled";
}
