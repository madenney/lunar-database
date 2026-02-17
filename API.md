# Lunar Melee API

REST API for the Lunar Melee Slippi replay archive. Provides access to hundreds of thousands of Super Smash Bros. Melee replay files with search, filtering, bulk download, and community submissions.

**Base URL:** `https://api.lunarmelee.com`

All responses are JSON. Errors return `{ "error": "message" }`.

---

## Table of Contents

- [Replays](#replays)
- [Download Jobs](#download-jobs)
- [Players](#players)
- [Stats](#stats)
- [Reference Data](#reference-data)
- [Submissions](#submissions)
- [Data Types](#data-types)

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
| `limit` | number | Results per page. Default: `50`. |

When both `p1` and `p2` filters are provided, they must match *different* players in the game (useful for searching head-to-head matchups).

**Response** `200`

```json
{
  "replays": [
    {
      "_id": "6651a...",
      "filePath": "/data/slp/netplay/2024-01/Game_20240115T201532.slp",
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

Get full details for a single replay.

**Response** `200` — The full [Replay](#replay) object.

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

## Download Jobs

Request bulk downloads of replays matching a filter. Replays are compressed with [slpz](https://github.com/Walnut356/slpz) (~8-12x smaller than raw .slp) and packaged into a `.tar` archive. The archive is uploaded to CDN storage and a download link is returned.

Download links expire after 48 hours.

### Estimate Download

```
POST /api/jobs/estimate
```

Preview how many replays match a filter and the estimated download size before creating a job. Use this to show the user what they're about to download.

**Request Body**

```json
{
  "connectCode": "AKLO#0",
  "characterId": 20,
  "stageId": 31,
  "startDate": "2024-01-01",
  "endDate": "2024-12-31"
}
```

All fields are optional, but **at least one filter is required**.

| Field | Type | Description |
|---|---|---|
| `connectCode` | string | Slippi connect code. |
| `characterId` | number | Character ID. |
| `stageId` | number | Stage ID. |
| `startDate` | string | ISO 8601 date. Games on or after. |
| `endDate` | string | ISO 8601 date. Games on or before. |

**Response** `200`

```json
{
  "replayCount": 342,
  "rawSize": 83886080,
  "estimatedCompressedSize": 10485760,
  "exceedsLimit": false,
  "limit": 5000
}
```

| Field | Type | Description |
|---|---|---|
| `replayCount` | number | Number of matching replays. |
| `rawSize` | number | Total raw file size in bytes. |
| `estimatedCompressedSize` | number | Estimated compressed size in bytes (conservative 8x estimate). |
| `exceedsLimit` | boolean | Whether the count exceeds the per-job maximum. |
| `limit` | number | Maximum replays allowed per job. |

**Response** `400` — No filter provided.

---

### Create Download Job

```
POST /api/jobs
```

Create a download job. The server will asynchronously compress and upload the matching replays. Poll the [job status](#get-job-status) endpoint to track progress.

**Request Body** — Same as [Estimate Download](#estimate-download). At least one filter is required.

**Response** `201`

```json
{
  "jobId": "6651a...",
  "status": "pending"
}
```

**Response** `400`

- No filter provided
- No replays match the filter
- Replay count exceeds the limit (narrow your filter)

---

### Get Job Status

```
GET /api/jobs/:id
```

Check the status and progress of a download job. Poll this endpoint to track the job through its lifecycle.

**Response** `200`

```json
{
  "jobId": "6651a...",
  "status": "compressing",
  "replayCount": 342,
  "estimatedSize": 83886080,
  "bundleSize": null,
  "downloadUrl": null,
  "expiresAt": null,
  "progress": {
    "step": "compressing",
    "filesProcessed": 150,
    "filesTotal": 342
  },
  "error": null,
  "createdAt": "2024-06-01T12:00:00.000Z",
  "completedAt": null
}
```

**Job Status Lifecycle**

| Status | Description |
|---|---|
| `pending` | Job is queued, waiting to be picked up. |
| `processing` | Worker has claimed the job and is querying replays. |
| `compressing` | Compressing .slp files with slpz. `progress` is updated during this step. |
| `uploading` | Uploading compressed archive to CDN. |
| `completed` | Done. `downloadUrl` and `expiresAt` are set. |
| `failed` | Something went wrong. See `error` field. |
| `expired` | Download link has expired (48 hours after completion). |

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `jobId` | string | Job ID. |
| `status` | string | Current status (see lifecycle above). |
| `replayCount` | number | Number of matching replays. |
| `estimatedSize` | number \| null | Raw file size in bytes before compression. |
| `bundleSize` | number \| null | Final compressed archive size in bytes. Set when completed. |
| `downloadUrl` | string \| null | Presigned CDN download URL. Set when completed, cleared when expired. |
| `expiresAt` | string \| null | ISO 8601 timestamp when the download link expires. |
| `progress` | object \| null | `{ step, filesProcessed, filesTotal }` during compressing/uploading, null otherwise. |
| `error` | string \| null | Error message if failed. |
| `createdAt` | string | ISO 8601 timestamp. |
| `completedAt` | string \| null | ISO 8601 timestamp when the job finished. |

**Response** `404` — `{ "error": "Job not found" }`

---

### Download Job Bundle

```
GET /api/jobs/:id/download
```

Redirects to the presigned CDN download URL. The download is a `.tar` archive containing `.slpz` compressed replay files.

To decompress the replays, extract the tar and run [slpz](https://github.com/Walnut356/slpz) to convert `.slpz` back to `.slp`.

**Response** `302` — Redirect to CDN download URL.

**Response** `400` — `{ "error": "Bundle not ready" }` — Job hasn't completed yet.

**Response** `410` — `{ "error": "Download has expired" }` — Link expired after 48 hours.

**Response** `404` — `{ "error": "Job not found" }`

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

## Submissions

Community replay uploads. Files go through an airlock (staging area) before being reviewed and added to the main archive.

### Upload Replays

```
POST /api/submissions/upload
```

Upload a `.slp` or `.zip` file containing replay(s). The request body should be the raw file bytes (not multipart form data).

**Headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/octet-stream` |
| `x-filename` | Yes | Original filename (e.g. `replays.zip`). Must end in `.slp` or `.zip`. |
| `x-submitted-by` | No | Who is submitting (connect code, name, etc). |

**Response** `202`

```json
{
  "uploadId": "6651a...",
  "filename": "replays.zip",
  "size": 1048576,
  "status": "extracting"
}
```

The upload is processed asynchronously. If a `.zip` is uploaded, individual `.slp` files are extracted and each becomes a separate submission. Poll the [upload status](#get-upload-status) to track processing.

---

### List Uploads

```
GET /api/submissions/uploads
```

List the 100 most recent uploads, newest first.

**Response** `200`

```json
[
  {
    "_id": "6651a...",
    "originalFilename": "replays.zip",
    "diskPath": "/data/airlock/a1b2c3-replays.zip",
    "fileSize": 1048576,
    "submittedBy": "AKLO#0",
    "status": "done",
    "slpCount": 12,
    "error": null,
    "createdAt": "2024-06-01T12:00:00.000Z",
    "updatedAt": "2024-06-01T12:00:05.000Z"
  }
]
```

**Upload Status Values:** `uploading`, `extracting`, `done`, `failed`

---

### Get Upload Status

```
GET /api/submissions/uploads/:id
```

Check the processing status of a specific upload.

**Response** `200` — Single [Upload](#upload) object.

**Response** `404` — `{ "error": "Upload not found" }`

---

### List Submissions

```
GET /api/submissions
```

List individual replay submissions extracted from uploads.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | `pending` | Filter by status: `pending`, `approved`, `rejected`, or `all`. |
| `uploadId` | string | — | Filter by upload ID. |
| `page` | number | `1` | Page number. |
| `limit` | number | `50` | Results per page (max 200). |

**Response** `200`

```json
{
  "submissions": [
    {
      "_id": "6651a...",
      "uploadId": "6651b...",
      "originalFilename": "Game_20240115T201532.slp",
      "airlockPath": "/data/airlock/a1b2c3-Game_20240115T201532.slp",
      "submittedBy": "AKLO#0",
      "status": "pending",
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
        }
      ],
      "winner": 0,
      "replayId": null,
      "reviewedAt": null,
      "createdAt": "2024-06-01T12:00:00.000Z",
      "updatedAt": "2024-06-01T12:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 12,
    "pages": 1
  }
}
```

---

### Get Submission

```
GET /api/submissions/:id
```

Get a single submission by ID.

**Response** `200` — Single [Submission](#submission) object.

**Response** `404` — `{ "error": "Submission not found" }`

---

### Approve Submission

```
POST /api/submissions/:id/approve
```

Approve a pending submission. Moves the file from the airlock into the main archive and creates a replay record.

**Response** `200`

```json
{
  "status": "approved",
  "replayId": "6651a..."
}
```

**Response** `400` — `{ "error": "Submission already approved" }`

**Response** `404` — `{ "error": "Submission not found" }`

---

### Reject Submission

```
POST /api/submissions/:id/reject
```

Reject a pending submission and delete the file from the airlock.

**Response** `200`

```json
{
  "status": "rejected"
}
```

**Response** `400` — `{ "error": "Submission already rejected" }`

**Response** `404` — `{ "error": "Submission not found" }`

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
| `filePath` | string | Server-side file path. |
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

## Rate Limits

No rate limits are currently enforced. Please be reasonable with request volume. This may change in the future.

## CORS

The API accepts requests from `lunarmelee.com` origins. If you need programmatic access from other origins, use server-side requests.
