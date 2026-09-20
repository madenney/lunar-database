import mongoose, { Schema, Document } from "mongoose";
import { config } from "../config";

export interface ISearchEvent extends Document {
  type: "search" | "estimate" | "player_search";
  clientId: string | null;
  filters: Record<string, any> | null; // replay search/estimate params
  query: string | null; // player search text
  resultCount: number | null;
  page: number | null;
  limit: number | null;
  estimatedSize: number | null; // raw bytes (estimate only)
  estimatedCount: number | null; // replay count (estimate only)
  createdAt: Date;
}

const SearchEventSchema = new Schema<ISearchEvent>(
  {
    type: { type: String, enum: ["search", "estimate", "player_search"], required: true },
    clientId: { type: String, default: null },
    filters: { type: Schema.Types.Mixed, default: null },
    query: { type: String, default: null },
    resultCount: { type: Number, default: null },
    page: { type: Number, default: null },
    limit: { type: Number, default: null },
    estimatedSize: { type: Number, default: null },
    estimatedCount: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// TTL: expire analytics events (which hold searched connect codes / display
// names + clientId) after the retention window so behavioral PII isn't kept
// forever (M3). This also serves as the plain createdAt query index. Changing
// the value on an existing deployment needs scripts/addEventTtl.ts (a bare
// createIndex conflicts with the pre-existing non-TTL index).
SearchEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: config.analyticsRetentionDays * 24 * 60 * 60 });
SearchEventSchema.index({ type: 1, createdAt: 1 });
SearchEventSchema.index({ clientId: 1, createdAt: 1 });

export const SearchEvent = mongoose.model<ISearchEvent>("SearchEvent", SearchEventSchema);
