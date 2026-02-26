# Lunar Melee API

REST API for the Lunar Melee Slippi replay archive. Provides access to hundreds of thousands of Super Smash Bros. Melee replay files with search, filtering, bulk download, and community submissions.

**Base URL:** `https://api.lunarmelee.com`

All responses are JSON. Errors return `{ "error": "message" }`.

---

## Table of Contents

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

## Authentication

### Client Identity

Most endpoints are public. For job management (creating, listing, and cancelling download jobs), the API uses a lightweight client identity system via the `X-Client-Id` header.

| Header | Description |
|---|---|
| `X-Client-Id` | A UUID generated and persisted in the frontend's `localStorage`. Not a login — just a stable anonymous identifier so users can track their own jobs. |

Endpoints that require `X-Client-Id` are marked below.

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
| `stageId` | number | Stage ID. Comma-separated for multiple. See [Reference Data](#get-stages). |
| `startDate` | string | ISO 8601 date. Only replays on or after this date. |
| `endDate` | string | ISO 8601 date. Only replays on or before this date. |
| `sort` | string | Sort field and direction as `field:direction`. Allowed fields: `startAt`, `indexedAt`, `duration`. Direction: `1` (ascending) or `-1` (descending). Default: `startAt:-1`. |
| `page` | number | Page number (1-indexed). Default: `1`. |
| `limit` | number | Results per page. Default: `50`, max: `200`. |

When both `p1` and `p2` filters are provided, they must match *different* players in the game (useful for searching head-to-head matchups).

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
      "folderLabel": "netplay",
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

All fields are optional. Values are comma-separated strings (same format as the search query params).

| Field | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Player 1 connect code(s), comma-separated. |
| `p1CharacterId` | string | Player 1 character ID(s), comma-separated. |
| `p1DisplayName` | string | Player 1 display name(s), comma-separated (prefix match). |
| `p2ConnectCode` | string | Player 2 connect code(s), comma-separated. |
| `p2CharacterId` | string | Player 2 character ID(s), comma-separated. |
| `p2DisplayName` | string | Player 2 display name(s), comma-separated (prefix match). |
| `stageId` | string | Stage ID(s), comma-separated. |
| `startDate` | string | ISO 8601 date. Games on or after. |
| `endDate` | string | ISO 8601 date. Games on or before. |
| `maxFiles` | number | Maximum number of replays to include. Applied before `maxSizeMb`. |
| `maxSizeMb` | number | Maximum total raw file size in megabytes. Applied after `maxFiles`. |

**Response** `200`

```json
{
  "replayCount": 342,
  "rawSize": 83886080,
  "estimatedSlpzSize": 10485760,
  "estimatedTarSize": 10836352,
  "estimatedTimeSec": 45,
  "totalDurationFrames": 2160000
}
```

| Field | Type | Description |
|---|---|---|
| `replayCount` | number | Number of matching replays. |
| `rawSize` | number | Total raw `.slp` file size in bytes. |
| `estimatedSlpzSize` | number | Estimated size after slpz compression in bytes (`rawSize / 8`). |
| `estimatedTarSize` | number | Estimated `.tar` archive size in bytes (`estimatedSlpzSize + replayCount * 1024`). |
| `estimatedTimeSec` | number | Estimated processing time in seconds (compression + upload). |
| `totalDurationFrames` | number | Sum of all matching replay durations in frames (60 fps). |

---

## Download Jobs

Request bulk downloads of replays matching a filter. Replays are compressed with [slpz](https://github.com/Walnut356/slpz) (~8x smaller than raw .slp) and packaged into a `.tar` archive. The archive is uploaded to CDN storage (Cloudflare R2) and a download link is provided.

### Create Download Job

```
POST /api/jobs
```

Create a download job. The server will asynchronously compress and upload the matching replays. Poll the [job status](#get-job-status) endpoint to track progress.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Client-Id` | Yes | Client identity UUID. Used to associate the job with your session. |

**Request Body** — Same filter fields as [POST /api/replays/estimate](#estimate-download-full-filters). Use the estimate endpoint first to preview counts and sizes.

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

| Field | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Player 1 connect code(s), comma-separated. |
| `p1CharacterId` | string | Player 1 character ID(s), comma-separated. |
| `p1DisplayName` | string | Player 1 display name(s), comma-separated (prefix match). |
| `p2ConnectCode` | string | Player 2 connect code(s), comma-separated. |
| `p2CharacterId` | string | Player 2 character ID(s), comma-separated. |
| `p2DisplayName` | string | Player 2 display name(s), comma-separated (prefix match). |
| `stageId` | string | Stage ID(s), comma-separated. |
| `startDate` | string | ISO 8601 date. Games on or after. |
| `endDate` | string | ISO 8601 date. Games on or before. |
| `maxFiles` | number | Maximum number of replays to include. Applied before `maxSizeMb`. |
| `maxSizeMb` | number | Maximum total raw file size in megabytes. Applied after `maxFiles`. |

All fields are optional, but at least one search filter (not just `maxFiles`/`maxSizeMb`) is required. The same filter can be passed to both `POST /api/replays/estimate` and `POST /api/jobs`.

The server stores `replayCount`, `estimatedSize`, and `estimatedProcessingTime` on the job at creation for queue position and ETA calculations.

**Response** `201`

```json
{
  "jobId": "6651a...",
  "status": "pending"
}
```

**Response** `400` — `{ "error": "No replays match this filter" }`

**Response** `429` — `{ "error": "You already have 3 active job(s). Maximum is 3. Wait for one to finish or cancel it." }` — Per-client concurrent job limit reached. Applies to jobs in `pending`, `processing`, `compressing`, `compressed`, or `uploading` status.

**Response** `503` — `{ "error": "Job queue is full (50 pending). Try again later." }` — Global pending queue is at capacity.

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
      "completedAt": "2024-06-01T12:05:00.000Z"
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

---

### Cancel My Job

```
DELETE /api/jobs/:id
```

Cancel one of your own active jobs. Only works on jobs with status `pending`, `processing`, `compressing`, `compressed`, or `uploading`.

**Headers**

| Header | Required | Description |
|---|---|---|
| `X-Client-Id` | Yes | Must match the `createdBy` on the job. |

**Response** `200` — `{ "message": "Job cancelled" }`

**Response** `403` — `{ "error": "Not your job" }`

**Response** `400` — `{ "error": "Cannot cancel a completed job" }` (or similar for the current status)

**Response** `404` — `{ "error": "Job not found" }`

---

### Get Job Status

```
GET /api/jobs/:id
```

Check the status and progress of a download job. Poll this endpoint to track the job through its lifecycle. No authentication required — anyone with the job ID can check status.

**Response** `200`

```json
{
  "jobId": "6651a...",
  "status": "compressing",
  "replayCount": 342,
  "estimatedSize": 83886080,
  "bundleSize": null,
  "downloadReady": false,
  "downloadCount": 0,
  "progress": {
    "step": "compressing",
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

**Job Status Lifecycle**

| Status | Description |
|---|---|
| `pending` | Job is queued, waiting to be picked up by the compressor. |
| `processing` | Compressor has claimed the job and is querying replays. |
| `compressing` | Compressing .slp files with slpz. `progress` is updated during this step. |
| `compressed` | Compression complete, waiting for the uploader to pick it up. |
| `uploading` | Uploading compressed archive to CDN. |
| `completed` | Done. `downloadReady` is `true`. |
| `failed` | Something went wrong. See `error` field. |
| `cancelled` | Job was cancelled by the user or an admin. |

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `jobId` | string | Job ID. |
| `status` | string | Current status (see lifecycle above). |
| `replayCount` | number | Number of matching replays. |
| `estimatedSize` | number \| null | Raw file size in bytes before compression. |
| `bundleSize` | number \| null | Final compressed archive size in bytes. Set when completed. |
| `downloadReady` | boolean | `true` when the job is completed and the archive is available. |
| `downloadCount` | number | Number of times this bundle has been downloaded. |
| `progress` | object \| null | `{ step, filesProcessed, filesTotal }` during compressing/uploading. |
| `error` | string \| null | Error message if failed. |
| `queuePosition` | number \| null | 1-based position in queue (1 = next up). `0` = currently processing. `null` for terminal statuses. |
| `estimatedWaitSec` | number \| null | Estimated seconds until the job starts processing. Includes remaining time of active job. `null` for terminal statuses. |
| `estimatedProcessingTimeSec` | number \| null | Estimated seconds for this job to process. Remaining time if active. `null` for terminal statuses. |
| `startedAt` | string \| null | ISO 8601 timestamp when the worker started processing. `null` while pending. |
| `createdAt` | string | ISO 8601 timestamp. |
| `completedAt` | string \| null | ISO 8601 timestamp when the job finished. |

**Response** `404` — `{ "error": "Job not found" }`

---

### Download Job Bundle

```
GET /api/jobs/:id/download
```

Redirects to a fresh presigned CDN download URL (valid for 1 hour). The download is a `.tar` archive containing `.slpz` compressed replay files. Each download increments the job's `downloadCount`.

To decompress the replays, extract the tar and run [slpz](https://github.com/Walnut356/slpz) to convert `.slpz` back to `.slp`.

**Response** `302` — Redirect to presigned R2 download URL.

**Response** `400` — `{ "error": "Download not ready" }` — Job hasn't completed or archive is missing.

**Response** `404` — `{ "error": "Job not found" }`

---

### Browse Bundle Catalog

```
GET /api/jobs/bundles
```

Public catalog of completed download bundles, sorted by popularity (most downloaded first). Useful for discovering and reusing existing bundles instead of creating duplicate jobs.

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
      "completedAt": "2024-06-01T12:05:00.000Z"
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
| `q` | string | Yes | Search query (minimum 1 character). |
| `limit` | number | No | Max results. Default: `10`, max: `25`. |

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

Results are sorted by game count (most active players first).

**Response** `400` — Query too short.

---

### Search Players

```
GET /api/players/search
```

Search players by connect code or display name. Same as autocomplete but with higher limits, intended for dedicated search pages.

**Query Parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Search query (minimum 2 characters). |
| `limit` | number | No | Max results. Default: `20`, max: `50`. |

**Response** `200` — Same format as [Autocomplete](#autocomplete-players).

**Response** `400` — Query too short.

---

## Stats

### Get Archive Stats

```
GET /api/stats
```

Overview statistics for the entire archive.

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
  "totalFileSizeBytes": 21990232555520
}
```

| Field | Type | Description |
|---|---|---|
| `replays` | number | Total non-junk replays in the archive. |
| `jobs` | object | Count of download jobs by status. |
| `dbSizeBytes` | number | MongoDB data size in bytes. |
| `totalFileSizeBytes` | number | Sum of all replay file sizes in bytes. |

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
| `winner` | number \| null | `playerIndex` of the winner, or null if inconclusive. |
| `folderLabel` | string \| null | Source category: `netplay`, `ranked_anonymized`, `tournament`, `uploads`. |
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
| Job timeout | 60 min | `JOB_TIMEOUT_MINUTES` | Jobs exceeding this are marked `failed`. |
| slpz process timeout | 30 min | `SLPZ_TIMEOUT_MINUTES` | Compression subprocess timeout. |
| Min free disk | 2,048 MB | `MIN_FREE_DISK_MB` | Jobs won't start if temp disk is below this threshold. |

---

## Rate Limits

| Scope | Limit |
|---|---|
| Global | 100 requests per minute per IP |

Rate limit headers (`RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) are included in responses.

---

## CORS

The API accepts requests from `lunarmelee.com` origins. If you need programmatic access from other origins, use server-side requests.
