import type { Response } from "express";

/**
 * Machine-readable error codes returned as `{ error, code }` by the public API.
 * Clients (the website, and through it Clipper) branch on `code` and own their
 * user-facing wording; `error` is a plain-English fallback for logs and tools.
 *
 * This file is part of the cross-app contract: the root test
 * scripts/test/api-errors.test.mjs checks that the website handles every code.
 * Keep it free of runtime imports so that test can load it directly.
 */
export const API_ERROR_CODES = {
  /** 400: estimate/job without any filter or limit. */
  filter_required: "Add at least one filter or a limit",
  /** 400: the filter matches no replays. */
  no_matches: "No replays match this filter",
  /** 400: missing or malformed X-Client-Id. */
  invalid_client: "A valid X-Client-Id header is required",
  /** 400: the job is not in a cancellable state. */
  cannot_cancel: "This job can no longer be cancelled",
  /** 400: the bundle is not built yet. */
  not_ready: "Download not ready",
  /** 403: the job belongs to another client. */
  forbidden: "Not authorized for this job",
  /** 404: no such job. */
  not_found: "Job not found",
  /** 410: the job completed but its bundle is gone from storage. */
  bundle_missing: "This bundle is no longer in storage",
  /** 429: generic request rate limit. */
  rate_limited: "Too many requests, please try again later",
  /** 429: the client already has the maximum number of active jobs. Extra: limit. */
  too_many_active_jobs: "Too many active jobs",
  /** 429: the global pending queue is full. */
  queue_full: "The job queue is full, try again later",
  /** 429: full-database download limit. Extra: retryAfterSeconds (+ Retry-After header). */
  fulldb_rate_limited: "Full database download limit reached",
  /** 503: storage provider's daily download cap is exhausted. */
  download_cap: "Daily download limit reached, please try again tomorrow",
  /** 503: storage provider is throttling or briefly unavailable. */
  storage_busy: "Storage is busy, please try again shortly",
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/** Send `{ error, code, ...extra }` with the code's default message unless one is given. */
export function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  extra: Record<string, unknown> & { error?: string } = {},
): void {
  const { error, ...rest } = extra;
  res.status(status).json({ error: error ?? API_ERROR_CODES[code], code, ...rest });
}
