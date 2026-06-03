/**
 * Sanitize an error message before storing in the database.
 * Strips internal paths and stack traces; keeps the gist.
 */

const PATH_RE = /\/[\w\-./]+/g;
const MAX_LEN = 500;

const KNOWN_MESSAGES: [RegExp, string][] = [
  [/slp root directory not found/i, "Storage not available — drive may not be mounted"],
  [/slpz binary not found/i, "Compression tool not available"],
  [/insufficient disk space/i, "Insufficient disk space"],
  [/disk space dropped below/i, "Disk space critically low"],
  [/timed out/i, "Job timed out"],
  [/no replays matched/i, "No replays matched the filter"],
  [/no files were compressed/i, "No files could be compressed"],
  [/bundlepath is outside/i, "Internal path validation error"],
  [/ECONNREFUSED/i, "Storage service unavailable"],
  [/ENOSPC/i, "Disk full"],
];

/**
 * The set of already-sanitized, user-safe replacement messages. Any error that
 * matched a KNOWN_MESSAGES pattern is reduced to one of these — they contain no
 * paths or internal details, so they're safe to show to API consumers as-is.
 * The job status endpoint uses this to decide which stored errors to pass
 * through (vs. replacing with a generic message).
 */
export const SAFE_JOB_ERROR_MESSAGES: string[] = KNOWN_MESSAGES.map(([, msg]) => msg);

export function sanitizeJobErrorMessage(raw: string): string {
  for (const [pattern, replacement] of KNOWN_MESSAGES) {
    if (pattern.test(raw)) return replacement;
  }
  // Strip filesystem paths from unknown errors
  return raw.replace(PATH_RE, "[path]").slice(0, MAX_LEN);
}
