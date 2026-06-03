/**
 * Sanitize a search filter object before storing in SearchEvent.
 * Only keeps known string/number keys, truncates strings.
 */
const MAX_LEN = 100;
const ALLOWED_KEYS = new Set([
  "p1CharacterId", "p1ConnectCode", "p1DisplayName",
  "p2CharacterId", "p2ConnectCode", "p2DisplayName",
  "stageId", "startDate", "endDate", "maxFiles", "maxSizeMb",
]);

export function sanitizeFilters(raw: Record<string, any> | null | undefined): Record<string, string | number> | null {
  if (!raw || typeof raw !== "object") return null;
  const clean: Record<string, string | number> = {};
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    const val = raw[key];
    if (typeof val === "number" && Number.isFinite(val)) {
      clean[key] = val;
    } else if (typeof val === "string") {
      clean[key] = val.slice(0, MAX_LEN);
    }
  }
  return Object.keys(clean).length > 0 ? clean : null;
}
