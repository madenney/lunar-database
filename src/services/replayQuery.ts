import { IJobFilter } from "../models/Job";

export function buildReplayQuery(filter: IJobFilter): Record<string, any> {
  const query: Record<string, any> = {};

  if (filter.connectCode) {
    query["players.connectCode"] = filter.connectCode;
  }
  if (filter.characterId != null) {
    query["players.characterId"] = filter.characterId;
  }
  if (filter.stageId != null) {
    query.stageId = filter.stageId;
  }
  if (filter.startDate || filter.endDate) {
    query.startAt = {};
    if (filter.startDate) query.startAt.$gte = filter.startDate;
    if (filter.endDate) query.startAt.$lte = filter.endDate;
  }

  return query;
}
