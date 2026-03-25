import mongoose, { Schema, Document } from "mongoose";

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

SearchEventSchema.index({ createdAt: 1 });
SearchEventSchema.index({ type: 1, createdAt: 1 });
SearchEventSchema.index({ clientId: 1, createdAt: 1 });

export const SearchEvent = mongoose.model<ISearchEvent>("SearchEvent", SearchEventSchema);
