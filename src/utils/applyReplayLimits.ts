/**
 * Apply maxFiles and maxSizeMb limits to an array of replays.
 * maxFiles is applied first (slice), then maxSizeMb (accumulate until cap).
 */
export function applyReplayLimits<T extends { fileSize?: number | null }>(
  replays: T[],
  maxFiles?: number,
  maxSizeMb?: number,
): T[] {
  let result = replays;

  if (maxFiles != null && maxFiles > 0) {
    result = result.slice(0, maxFiles);
  }

  if (maxSizeMb != null && maxSizeMb > 0) {
    const maxBytes = maxSizeMb * 1024 * 1024;
    let acc = 0;
    const capped: T[] = [];
    for (const r of result) {
      const size = r.fileSize ?? 0;
      if (acc + size > maxBytes && capped.length > 0) break;
      capped.push(r);
      acc += size;
    }
    result = capped;
  }

  return result;
}
