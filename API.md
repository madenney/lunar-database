# Lunar Melee API

REST API for the Lunar Melee Slippi replay archive. Provides access to hundreds of thousands of Super Smash Bros. Melee replay files with search, filtering, bulk download, and community submissions.

**Base URL:** `https://api.lunarmelee.com`

All responses are JSON. Errors return `{ "error": "message" }`; errors with a machine-readable [error code](#errors) return `{ "error", "code", ...extra }`.

---

## Table of Contents

- [Errors](#errors)
- [Authentication](#authentication)
- [Replays](#replays)
- [Estimates](#estimates)
- [Download Jobs](#download-jobs)
- [Players](#players)
- [Stats](#stats)
- [Reference Data](#reference-data)
- [Health Check](#health-check)
- [Data Types](#data-types)
- [Resource Limits](#resource-limits)
- [Rate Limits](#rate-limits)
- [CORS](#cors)

---

## Errors

Job and estimate errors, and every rate-limit response, carry a `code` (canonical list: `src/utils/apiErrors.ts`). `error` is a plain-English fallback; clients should branch on `code`, not on message text. Other errors (e.g. replay/player `400`/`404`, invalid IDs, `500`) return `{ "error" }` only.

| Code | Status | Meaning |
|---|---|---|
| `filter_required` | 400 | Estimate or job without any filter or limit. |
| `no_matches` | 400 | The filter matches no replays. |
| `invalid_client` | 400 | Missing or malformed `X-Client-Id`. |
| `cannot_cancel` | 400 | The job is no longer active. Extra: `status`. |
| `not_ready` | 400 | The bundle is not built yet. |
| `forbidden` | 403 | The job belongs to another client. |
| `not_found` | 404 | No such job. |
| `bundle_missing` | 410 | The job completed but its bundle is gone from storage. |
| `rate_limited` | 429 | A request rate limit was hit (every [rate limiter](#rate-limits)). |
| `too_many_active_jobs` | 429 | The client has the maximum number of active jobs. Extra: `limit`. |
| `queue_full` | 429 | The global pending queue is full. |
| `fulldb_rate_limited` | 429 | Full-database download limit. Extra: `retryAfterSeconds`, plus a `Retry-After` header. |
| `download_cap` | 503 | Storage provider's daily download cap is exhausted. |
| `storage_busy` | 503 | Storage provider is throttling or briefly unavailable. |

---

## Authentication

### Client Identity

Most endpoints are public. For job management (creating, listing, and cancelling download jobs), the API uses a lightweight client identity system via the `X-Client-Id` header.

| Header | Description |
|---|---|
| `X-Client-Id` | A UUID identifying the visitor. The website derives it server-side (`getClientId` in `apps/website/src/utils/downloadActions/shared.ts`): a UUID from a hash of the signed-in email, or of `anon:` + the visitor's IP. Not a login — just a stable identifier so users can track their own jobs. If present it must be a UUID (`400 invalid_client` otherwise). |

Endpoints that require `X-Client-Id` are marked below.

### Service Key

The website calls this API on behalf of visitors. With `LUNAR_SERVICE_KEY` set on both sides, it sends:

| Header | Description |
|---|---|
| `X-Lunar-Service-Key` | The shared key. Marks the request as a trusted website call. |
| `X-Visitor-Ip` | The visitor's IP, so rate limits apply per visitor rather than to the website's address. Trusted only with a valid key. |

Once a key is configured, `X-Client-Id` and `X-Visitor-Ip` from any caller without the key are dropped, so job ownership cannot be claimed by calling the API directly. With no key configured, headers are accepted as sent.

---

## Replays

### Search Replays

```
GET /api/replays
```

Search and filter the replay archive with pagination. Automatically excludes junk replays (no stage or character data).

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Player 1 Slippi connect code (e.g. `AKLO#0`). Comma-separated for multiple. |
| `p1CharacterId` | number | Player 1 character ID. Comma-separated for multiple. See [Reference Data](#get-characters). |
| `p1DisplayName` | string | Player 1 display name (prefix match, case-insensitive). Comma-separated for multiple. |
| `p2ConnectCode` | string | Player 2 connect code. Same format as p1. |
| `p2CharacterId` | number | Player 2 character ID. Same format as p1. |
| `p2DisplayName` | string | Player 2 display name. Same format as p1. |
| `p1Rank` / `p2Rank` | string | Rank tier(s): `platinum`, `diamond`, `master`. Comma-separated. Ranked replays only (their display name is the tier); takes precedence over that side's display name. |
| `stageId` | number | Stage ID. Comma-separated for multiple. See [Reference Data](#get-stages). |
| `source` | string | Replay source(s): `netplay`, `ranked`, `tournament`. Comma-separated; unknown values ignored. |
| `startDate` | string | ISO 8601 date. Only replays on or after this date. |
| `endDate` | string | ISO 8601 date. Only replays on or before this date. A date-only value (`2024-01-31`) includes that whole UTC day. |
| `sort` | string | Sort field and direction as `field:direction`. Allowed fields: `startAt`, `indexedAt`, `duration`. Direction: `1` (ascending) or `-1` (descending). Default: `startAt:-1`. |
| `page` | number | Page number (1-indexed). Default: `1`. |
| `limit` | number | Results per page. Default: `50`, max: `1000`. |

List values are comma-joined and trimmed, with at most 20 values per field.

When both `p1` and `p2` filters (including ranks) are provided, they must match *different* players, in any of the up to four player slots (useful for searching head-to-head matchups).

Ascending `startAt` sort excludes undated replays, unless no matching replay is dated (e.g. the `ranked` source), in which case the undated replays are returned. [Estimates](#estimates), job creation and the bundle worker use this same selection, so they agree on the replays a search selects.

**Response** `200`

```json
{
  "replays": [
    {
      "_id": "6651a...",
      "fileHash": "a1b2c3...",
      "fileSize": 245760,
      "stageId": 31,
      "stageName": "Battlefield",
      "startAt": "2024-01-15T20:15:32.000Z",
      "duration": 7200,
      "players": [
        {
          "playerIndex": 0,
          "connectCode": "AKLO#0",
          "displayName": "Aklo",
          "tag": null,
          "characterId": 20,
          "characterName": "Falco"
        },
        {
          "playerIndex": 1,
          "connectCode": "MANG#0",
          "displayName": "mang0",
          "tag": null,
          "characterId": 2,
          "characterName": "Fox"
        }
      ],
      "winner": 0,
      "folderLabel": "netplay/2024-01",
      "source": "netplay",
      "usable": true,
      "viewCount": 0,
      "indexedAt": "2024-02-10T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1423,
    "pages": 29
  }
}
```

Note: `filePath` is excluded from search results.

**Examples**

```bash
# All Fox vs Falco games on Battlefield
curl "https://api.lunarmelee.com/api/replays?p1CharacterId=2&p2CharacterId=20&stageId=31"

# A specific player's games in January 2024
curl "https://api.lunarmelee.com/api/replays?p1ConnectCode=AKLO%230&startDate=2024-01-01&endDate=2024-01-31"

# Games on Dreamland or Fountain of Dreams, sorted by longest first
curl "https://api.lunarmelee.com/api/replays?stageId=28,2&sort=duration:-1"
```

---

### Get Replay

```
GET /api/replays/:id
```

Get full details for a single replay. `filePath` is excluded.

**Response** `200` — The [Replay](#replay) object.

**Response** `404` — `{ "error": "Replay not found" }`

---

### Record Replay View

```
POST /api/replays/:id/view
```

Record one in-browser watch by incrementing the replay's `viewCount`. Callers dedupe per session.

**Response** `200` — `{ "viewCount": 12 }` (the new count)

**Response** `404` — `{ "error": "Replay not found" }`

---

### Download Replay

```
GET /api/replays/:id/download
```

Download the raw `.slp` file for a single replay.

**Response** `200` — Binary `.slp` file with `Content-Disposition` header.

**Response** `404` — `{ "error": "Replay not found" }`

---

## Estimates

### Estimate Download (Full Filters)

```
POST /api/replays/estimate
```

Estimate replay count, compressed download size, and processing ETA using the full replay search filter syntax. Supports the same p1/p2 positional matching as [Search Replays](#search-replays). Use this for instant download size previews in the UI.

**Request Body**

```json
{
  "p1ConnectCode": "AKLO#0",
  "p1CharacterId": "20",
  "p2CharacterId": "2",
  "stageId": "31",
  "startDate": "2024-01-01",
  "endDate": "2024-12-31"
}
```

All fields are optional. Values are comma-separated strings (same format as the search query params). The body is parsed exactly as [POST /api/jobs](#create-download-job) parses it (`parseFilter` in `src/services/replayFilter.ts`): unknown keys are ignored and list fields are trimmed and capped at 20 values, so an estimate describes the bundle a job would build.

| Field | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Player 1 connect code(s), comma-separated. |
| `p1CharacterId` | string | Player 1 character ID(s), comma-separated. |
| `p1DisplayName` | string | Player 1 display name(s), comma-separated (prefix match). |
| `p1Rank` | string | Player 1 rank tier(s): `platinum`, `diamond`, `master`. Selecting all three is no filter. |
| `p2ConnectCode` | string | Player 2 connect code(s), comma-separated. |
| `p2CharacterId` | string | Player 2 character ID(s), comma-separated. |
| `p2DisplayName` | string | Player 2 display name(s), comma-separated (prefix match). |
| `p2Rank` | string | Player 2 rank tier(s). Same format as `p1Rank`. |
| `stageId` | string | Stage ID(s), comma-separated. |
| `source` | string | Source(s): `netplay`, `ranked`, `tournament`. Selecting all three is no filter. |
| `startDate` | string | ISO 8601 date. Games on or after. |
| `endDate` | string | ISO 8601 date. Games on or before (a date-only value includes that whole UTC day). |
| `sort` | string | Same as the search `sort` param. Decides which replays a `maxFiles`/`maxSizeMb` limit keeps. |
| `maxFiles` | number | Maximum number of replays to include. Applied before `maxSizeMb`. |
| `maxSizeMb` | number | Maximum total raw file size in megabytes, capped at `10000`. Applied after `maxFiles`. |

**Response** `400` — `filter_required` when the body has neither a filter nor a limit.

**Response** `200`

```json
{
  "replayCount": 342,
  "rawSize": 83886080,
  "estimatedSlpzSize": 10485760,
  "estimatedZipSize": 10836352,
  "estimatedTimeSec": 45,
  "totalDurationFrames": 2160000
}
```

| Field | Type | Description |
|---|---|---|
| `replayCount` | number | Number of matching replays. |
| `rawSize` | number | Total raw `.slp` file size in bytes. |
| `estimatedSlpzSize` | number | Estimated size after slpz compression in bytes (`rawSize / 8`). |
| `estimatedZipSize` | number | Estimated `.zip` archive size in bytes (`estimatedSlpzSize + replayCount * 128`). |
| `estimatedTimeSec` | number | Estimated processing time in seconds (compression + upload). |
| `totalDurationFrames` | number | Sum of all matching replay durations in frames (60 fps). |

---

## Download Jobs

Request bulk downloads of replays matching a filter. Replays are compressed with [slpz](https://github.com/Walnut356/slpz) (~8x smaller than raw .slp) and packaged into a `.zip` archive (store mode — no additional compression). The archive is uploaded to CDN storage and a download link is provided.

### Create Download Job

```
POST /api/jobs
```

Create a download job. The server will asynchronously compress and upload the matching replays. Poll the [job status](#get-job-status) endpoint to track progress.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Client-Id` | Yes | Client identity UUID. Used to associate the job with your session. |

**Request Body** — Same fields and parsing as [POST /api/replays/estimate](#estimate-download-full-filters). Use the estimate endpoint first to preview counts and sizes.

```json
{
  "p1ConnectCode": "AKLO#0",
  "p1CharacterId": "20",
  "p2CharacterId": "2",
  "stageId": "31",
  "startDate": "2024-01-01",
  "endDate": "2024-12-31"
}
```

All fields are optional, but a filter or a limit (`maxFiles`/`maxSizeMb`) is required. The same filter can be passed to both `POST /api/replays/estimate` and `POST /api/jobs`.

The server stores `replayCount`, `totalMatched` (uncapped match count, when a limit trims a filtered selection), `estimatedSize`, and `estimatedProcessingTime` on the job at creation for queue position and ETA calculations.

**Response** `201`

```json
{
  "jobId": "6651a...",
  "status": "pending"
}
```

**Response** `400` — `invalid_client`, `filter_required`, or `no_matches`.

**Response** `429` — `too_many_active_jobs` (with `limit`) — Per-client concurrent job limit reached. Applies to jobs in `pending`, `processing`, `bundling`, `bundled`, or `uploading` status.

**Response** `429` — `queue_full` — Global pending queue is at capacity.

---

### List My Jobs

```
GET /api/jobs
```

List download jobs created by the current client, newest first.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Client-Id` | Yes | Must match the ID used when creating jobs. |

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | number | `1` | Page number. |
| `limit` | number | `20` | Results per page, max `100`. |

**Response** `200`

```json
{
  "jobs": [
    {
      "_id": "6651a...",
      "status": "completed",
      "filter": {
        "p1ConnectCode": "AKLO#0"
      },
      "replayCount": 342,
      "bundleSize": 10836352,
      "progress": null,
      "error": null,
      "downloadReady": true,
      "createdAt": "2024-06-01T12:00:00.000Z",
      "completedAt": "2024-06-01T12:05:00.000Z",
      "lastDownloadedAt": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 3,
    "pages": 1
  }
}
```

| Field | Type | Description |
|---|---|---|
| `downloadReady` | boolean | `true` when the job is completed and the archive is available for download. |

**Response** `400` — `invalid_client` (missing `X-Client-Id`).

---

### Cancel My Job

```
DELETE /api/jobs/:id
```

Cancel one of your own active jobs. Only works on jobs with status `pending`, `processing`, `bundling`, `bundled`, or `uploading`. The cancel is a single conditional update, so it cannot overwrite a job a worker finishes at the same moment.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Client-Id` | Yes | Must match the `createdBy` on the job. |

**Response** `200` — `{ "message": "Job cancelled" }`

**Response** `400` — `invalid_client`, or `cannot_cancel` (with the job's current `status`) when the job is no longer active.

**Response** `403` — `forbidden`

**Response** `404` — `not_found`

---

### Get Job Status

```
GET /api/jobs/:id
```

Check the status and progress of a download job. Poll this endpoint to track the job through its lifecycle. Requires the owner's `X-Client-Id`.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Client-Id` | Yes | Must match the `createdBy` on the job. |

**Response** `200`

Bundling example:

```json
{
  "jobId": "6651a...",
  "status": "bundling",
  "replayCount": 342,
  "totalMatched": 342,
  "capped": false,
  "estimatedSize": 83886080,
  "bundleSize": null,
  "downloadReady": false,
  "pinned": false,
  "downloadCount": 0,
  "progress": {
    "step": "bundling",
    "filesProcessed": 150,
    "filesTotal": 342
  },
  "error": null,
  "queuePosition": 0,
  "estimatedWaitSec": 0,
  "estimatedProcessingTimeSec": 85,
  "startedAt": "2024-06-01T12:00:05.000Z",
  "createdAt": "2024-06-01T12:00:00.000Z",
  "completedAt": null
}
```

Uploading example (with byte-level progress):

```json
{
  "jobId": "6651a...",
  "status": "uploading",
  "replayCount": 342,
  "estimatedSize": 83886080,
  "bundleSize": 10836352,
  "downloadReady": false,
  "downloadCount": 0,
  "progress": {
    "step": "uploading",
    "filesProcessed": 0,
    "filesTotal": 1,
    "bytesUploaded": 5242880,
    "bytesTotal": 10836352
  },
  "error": null,
  "queuePosition": 0,
  "estimatedWaitSec": 0,
  "estimatedProcessingTimeSec": 12,
  "startedAt": "2024-06-01T12:00:05.000Z",
  "createdAt": "2024-06-01T12:00:00.000Z",
  "completedAt": null
}
```

**Job Status Lifecycle**

| Status | Description |
|---|---|
| `pending` | Job is queued, waiting to be picked up by the compressor. |
| `processing` | Compressor has claimed the job and is querying replays. |
| `bundling` | Compressing .slp files with slpz and zipping them. `progress` is updated during this step. |
| `bundled` | Bundle built, waiting for the uploader to pick it up. |
| `uploading` | Uploading compressed archive to CDN. `progress.bytesUploaded` / `progress.bytesTotal` track byte-level upload progress (updated every ~1%). |
| `completed` | Done. `downloadReady` is `true`. |
| `failed` | Something went wrong. See `error` field. |
| `cancelled` | Job was cancelled by the user or an admin. |

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `jobId` | string | Job ID. |
| `status` | string | Current status (see lifecycle above). |
| `replayCount` | number | Number of replays in the job (after any limit). |
| `totalMatched` | number \| null | Replays the filter matched before a limit trimmed it. |
| `capped` | boolean | `true` when a limit trimmed the selection (`totalMatched > replayCount`). |
| `estimatedSize` | number \| null | Raw file size in bytes before compression. |
| `bundleSize` | number \| null | Final compressed archive size in bytes. Set once bundled. |
| `downloadReady` | boolean | `true` when the job is completed and the archive is available. |
| `pinned` | boolean | Whether the bundle is permanently retained. |
| `downloadCount` | number | Number of times this bundle has been downloaded. |
| `progress` | object \| null | Progress during `bundling` and `uploading` steps, null otherwise. See [Progress Object](#progress-object) below. |
| `error` | string \| null | Error message if failed. |
| `queuePosition` | number \| null | 1-based position in queue (1 = next up). `0` = currently processing. `null` for terminal statuses. |
| `estimatedWaitSec` | number \| null | Estimated seconds until the job starts processing. Includes remaining time of active job. `null` for terminal statuses. |
| `estimatedProcessingTimeSec` | number \| null | Estimated seconds for this job to process. Remaining time if active. `null` for terminal statuses. |
| `startedAt` | string \| null | ISO 8601 timestamp when the worker started processing. `null` while pending. |
| `createdAt` | string | ISO 8601 timestamp. |
| `completedAt` | string \| null | ISO 8601 timestamp when the job finished. |
| `lastDownloadedAt` | string \| null | ISO 8601 timestamp of the latest download. |
| `expiresAt` | string \| null | When an unpinned completed bundle will be removed from storage (retention runs from the last download, or completion). `null` otherwise. |

#### Progress Object

The `progress` field is non-null during `bundling` and `uploading` steps, null otherwise.

| Field | Type | Present | Description |
|---|---|---|---|
| `step` | string | always | `"bundling"` or `"uploading"`. |
| `filesProcessed` | number | always | Files compressed so far (bundling), or `0` (uploading). |
| `filesTotal` | number | always | Total files to compress (bundling), or `1` (uploading). |
| `bytesUploaded` | number | uploading | Bytes uploaded to CDN so far. Updated every ~1% of total. |
| `bytesTotal` | number | uploading | Total bytes to upload (equals `bundleSize`). |

During `bundling`, use `filesProcessed / filesTotal` for the progress bar. During `uploading`, use `bytesUploaded / bytesTotal`:

```ts
if (progress.step === "bundling") {
  percent = progress.filesProcessed / progress.filesTotal;
} else if (progress.step === "uploading") {
  percent = progress.bytesUploaded / progress.bytesTotal;
}
```

**Response** `403` — `forbidden`

**Response** `404` — `not_found`

---

### Download Job Bundle

```
GET /api/jobs/:id/download
```

Returns a presigned storage download URL, valid for 1 hour. The download is a `.zip` archive containing `.slpz` compressed replay files and a `lunar-manifest.json` mapping each file to its replay: `{ "version": 1, "replays": [{ "file": "12_Game_….slpz", "replayId": "…", "fileHash": "…" }] }` (see `src/services/bundleManifest.ts`). Entry names are unique per bundle only; `replayId` and `fileHash` identify a replay across bundles. Each download increments the job's `downloadCount`. Requires the owner's `X-Client-Id`, except for pinned bundles, which any visitor may download.

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `filename` | string | Optional name for the saved file (sanitized, forced to `.zip`). Default: `lunar-db-<last 8 of job id>`. |

To decompress the replays, extract the zip and run [slpz](https://github.com/Walnut356/slpz) to convert `.slpz` back to `.slp`.

**Response** `200`

```json
{
  "url": "https://<storage host>/jobs/6651a....zip?<signature>"
}
```

**Response** `400` — `not_ready` — Job hasn't completed or archive is missing.

**Response** `403` — `forbidden` — Not the owner, and the bundle is not pinned.

**Response** `404` — `not_found`

**Response** `410` — `bundle_missing` — The bundle is no longer in storage.

**Response** `429` — `fulldb_rate_limited` (with `retryAfterSeconds` and a `Retry-After` header) — Full-database bundles only.

**Response** `503` — `download_cap` or `storage_busy` — Storage cannot serve the download right now.

---

### Browse Bundle Catalog

```
GET /api/jobs/bundles
```

Public catalog of pinned (permanent) download bundles, the ones any visitor may download. The full-database bundle is listed first, then by popularity (most downloaded first). Useful for discovering and reusing existing bundles instead of creating duplicate jobs.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | number | `1` | Page number. |
| `limit` | number | `20` | Results per page, max `50`. |

**Response** `200`

```json
{
  "bundles": [
    {
      "_id": "6651a...",
      "filter": {
        "p1ConnectCode": "AKLO#0"
      },
      "replayCount": 342,
      "bundleSize": 10836352,
      "downloadCount": 15,
      "completedAt": "2024-06-01T12:05:00.000Z",
      "lastDownloadedAt": "2024-06-03T09:00:00.000Z",
      "fullDb": false
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 47,
    "pages": 3
  }
}
```

| Field | Type | Description |
|---|---|---|
| `filter` | object | The filter used to create this bundle. |
| `replayCount` | number | Number of replays in the bundle. |
| `bundleSize` | number | Compressed archive size in bytes. |
| `downloadCount` | number | Number of times this bundle has been downloaded. |
| `completedAt` | string | ISO 8601 timestamp when the bundle was created. |
| `fullDb` | boolean | `true` for the full-database bundle. |

---

## Players

### Autocomplete Players

```
GET /api/players/autocomplete
```

Fast prefix search for player connect codes and display names. Designed for search-as-you-type UI.

**Query Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | No | Search query (max 100 characters). Empty or missing returns the top players by game count. |
| `limit` | number | No | Max results. Default: `10`, max: `100`. |

**Response** `200`

```json
[
  {
    "connectCode": "AKLO#0",
    "displayName": "Aklo",
    "tag": null,
    "gameCount": 4521
  }
]
```

Results are sorted by game count (most active players first). Queries of 4+ characters also match connect codes whose tag is a prefix of the query (e.g. `mango` finds `MANG#0`).

**Response** `400` — `{ "error": "Query too long (max 100 characters)" }`

---

### Search Players

```
GET /api/players/search
```

Search players by connect code or display name. Same as autocomplete but with higher limits, intended for dedicated search pages.

**Query Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Search query (2–100 characters). |
| `limit` | number | No | Max results. Default: `20`, max: `50`. |

**Response** `200` — Same format as [Autocomplete](#autocomplete-players).

**Response** `400` — Query shorter than 2 or longer than 100 characters.

---

## Stats

### Get Archive Stats

```
GET /api/stats
```

Overview statistics for the entire archive. Replay totals are cached for up to a
minute; job counts are always current.

**Response** `200`

```json
{
  "replays": 542110,
  "jobs": {
    "pending": 2,
    "completed": 47,
    "failed": 1
  },
  "dbSizeBytes": 1073741824,
  "totalFileSizeBytes": 21990232555520,
  "totalDurationFrames": 3888000000,
  "replaysWithDuration": 540002
}
```

| Field | Type | Description |
|---|---|---|
| `replays` | number | Total non-junk replays in the archive. |
| `jobs` | object | Count of download jobs keyed by status. Only statuses with at least one job are present. |
| `dbSizeBytes` | number | MongoDB data size in bytes. |
| `totalFileSizeBytes` | number | Sum of non-junk replay file sizes in bytes. |
| `totalDurationFrames` | number | Sum of non-junk replay durations in frames (60 fps). |
| `replaysWithDuration` | number | Non-junk replays with a positive duration. |

---

## Reference Data

Static data from [slippi-js](https://github.com/project-slippi/slippi-js). Use these to map IDs to human-readable names in your UI.

### Get Characters

```
GET /api/reference/characters
```

**Response** `200` — Array of all playable characters.

```json
[
  { "id": 0, "name": "Captain Falcon", "shortName": "Falcon", "colors": [...] },
  { "id": 1, "name": "Donkey Kong", "shortName": "DK", "colors": [...] },
  { "id": 2, "name": "Fox", "shortName": "Fox", "colors": [...] }
]
```

### Get Stages

```
GET /api/reference/stages
```

**Response** `200` — Array of all stages.

```json
[
  { "id": 2, "name": "Fountain of Dreams" },
  { "id": 3, "name": "Pokemon Stadium" },
  { "id": 8, "name": "Yoshi's Story" },
  { "id": 28, "name": "Dreamland" },
  { "id": 31, "name": "Battlefield" },
  { "id": 32, "name": "Final Destination" }
]
```

---

## Health Check

```
GET /health
```

**Response** `200`

```json
{ "ok": true }
```

```
GET /healthz
```

Liveness plus a cached deep health check, for status dashboards.

**Response** `200` — `{ "status": "ok" | "degraded", "detail": "..." }`. `detail` names only failing check keys; the full breakdown is at the admin `GET /api/admin/health`.

---

## Data Types

### Replay

| Field | Type | Description |
|---|---|---|
| `_id` | string | Unique ID. |
| `fileHash` | string | File hash for deduplication. |
| `fileSize` | number \| null | File size in bytes. |
| `stageId` | number \| null | Stage ID (see [Reference Data](#get-stages)). |
| `stageName` | string \| null | Human-readable stage name. |
| `startAt` | string \| null | ISO 8601 game start time. |
| `duration` | number \| null | Game duration in frames (60 fps). |
| `players` | Player[] | Array of players in the game. |
| `winner` | number \| null | `playerIndex` of the winner, or null if unknown. |
| `folderLabel` | string \| null | Import path label, e.g. `netplay/...` or `ranked_anonymized/...`. |
| `source` | string \| null | `netplay`, `ranked` or `tournament`, derived from the top folder of `folderLabel`. |
| `usable` | boolean \| null | Not junk (has players and a stage or character, and is not zero-length). Searches only return `true`. |
| `viewCount` | number | Times watched in the in-browser viewer. |
| `indexedAt` | string | ISO 8601 timestamp when the replay was indexed. |

### Player (in Replay)

| Field | Type | Description |
|---|---|---|
| `playerIndex` | number | Port index (0-3). |
| `connectCode` | string \| null | Slippi connect code (e.g. `AKLO#0`). Null for anonymous/offline. |
| `displayName` | string \| null | In-game display name. |
| `tag` | string \| null | Nametag (set on controller). |
| `characterId` | number \| null | Character ID (see [Reference Data](#get-characters)). |
| `characterName` | string \| null | Human-readable character name. |

### Player (in Players collection)

| Field | Type | Description |
|---|---|---|
| `connectCode` | string | Slippi connect code. |
| `displayName` | string \| null | Most recent display name. |
| `tag` | string \| null | Most recent nametag. |
| `gameCount` | number | Number of games in the archive. |

---

## Resource Limits

Job creation is subject to several safety limits to prevent runaway resource consumption:

| Limit | Default | Env Var | Description |
|---|---|---|---|
| Concurrent jobs per client | 3 | `JOB_MAX_CONCURRENT_PER_CLIENT` | Active (non-terminal) jobs per `X-Client-Id`. |
| Total pending queue | 50 | `JOB_MAX_PENDING_TOTAL` | Max pending jobs across all clients. |
| Job timeout | 480 min | `JOB_TIMEOUT_MINUTES` | Jobs exceeding this are marked `failed`. |
| slpz process timeout | 30 min | `SLPZ_TIMEOUT_MINUTES` | Compression subprocess timeout. |
| Min free disk | 2,048 MB | `MIN_FREE_DISK_MB` | Jobs won't start if temp disk is below this threshold. |
| Max bundle size | 10,000 MB | — | Upper bound on a job's `maxSizeMb`. |
| Full-database downloads | 2 per 24 h | `FULLDB_MAX_PER_WINDOW`, `FULLDB_WINDOW_HOURS` | Download URLs issued per client (or per IP without `X-Client-Id`) for the full-database bundle. |
| Bundle retention | 3 days | `STORAGE_CLEANUP_AFTER_DAYS` | Unpinned bundles are removed this long after their last download (or completion). |

---

## Rate Limits

Limits are counted per visitor: the forwarded `X-Visitor-Ip` for trusted website calls (see [Service Key](#service-key)), otherwise `CF-Connecting-IP`, then the socket address. Trusted website calls with no visitor IP are not limited. Every limit returns `429` with code `rate_limited`.

| Scope | Limit |
|---|---|
| Global (all routes) | 100 requests per minute |
| `GET /api/replays` | 30 per minute |
| `POST /api/replays/estimate` | 15 per minute |
| `GET /api/replays/:id` | 60 per minute |
| `POST /api/replays/:id/view` | 60 per minute |
| `GET /api/replays/:id/download` | 10 per minute |
| `POST /api/jobs` | 5 per hour |
| `GET /api/jobs` | 30 per minute |
| `GET /api/jobs/:id` | 60 per minute |
| `DELETE /api/jobs/:id` | 10 per minute |
| `GET /api/jobs/:id/download` | 20 per minute |
| `GET /api/jobs/bundles` | 30 per minute |
| `GET /api/players/autocomplete`, `/search` | 30 per minute (shared) |
| `GET /api/stats` | 60 per minute |
| `GET /health`, `/healthz` | 60 per minute (shared) |
| `POST /api/admin/login` | 30 per 15 minutes |
| Admin mutations | 30 per minute |
| Admin analytics and queue | 15 per minute |

Rate limit headers (`RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) are included in responses.

---

## CORS

The API accepts requests from `lunarmelee.com` origins. If you need programmatic access from other origins, use server-side requests.
