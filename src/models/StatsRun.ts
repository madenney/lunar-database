import mongoose, { Schema, Document } from "mongoose";
import { statsCollection } from "./GameStats";
import type { ExtractorName } from "../services/gameStats";

/**
 * A stats run: which extractors, at which versions, it computes (provenance for
 * everything its shards write). Immutable once created: when an extractor's
 * version changes, start a new run for it instead. Extend a run to newly crawled
 * replays by planning it again. See services/statsShards.ts.
 */
export interface IStatsRun extends Document<string> {
  _id: string;
  extractors: Partial<Record<ExtractorName, number>>;
  parser: string;
  createdAt: Date;
  createdBy: string;
}

const StatsRunSchema = new Schema<IStatsRun>(
  {
    _id: { type: String, required: true },
    extractors: { type: Schema.Types.Mixed, required: true },
    parser: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: String, required: true },
  },
  { collection: statsCollection("statsRuns") }
);

export const StatsRun = mongoose.model<IStatsRun>("StatsRun", StatsRunSchema);
