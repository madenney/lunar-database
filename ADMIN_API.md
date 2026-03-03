# Lunar Melee Admin API

Internal admin endpoints for managing the Lunar Melee replay archive. These are not public-facing — they require JWT authentication.

**Base URL:** `https://api.lunarmelee.com`

---

## Table of Contents

- [Authentication](#authentication)
- [System Status](#system-status)
- [Worker Control](#worker-control)
- [Job Management](#job-management)
- [Temp Storage](#temp-storage)
- [Submissions](#submissions)

---

## Authentication

### Login

```
POST /api/admin/login
```

Authenticate and receive a JWT token. Rate limited to 5 attempts per 15 minutes.

**Request Body**

```json
{
  "username": "admin",
  "password": "secret"
}
```

**Response** `200`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "username": "admin"
}
```

**Response** `401` — `{ "error": "Invalid credentials" }`

**Response** `429` — `{ "error": "Too many login attempts, please try again later" }`

### Using the Token

All other admin endpoints require the JWT in the `Authorization` header:

```
Authorization: Bearer <token>
```

**Response** `401` — `{ "error": "Authentication required" }` (missing header) or `{ "error": "Invalid or expired token" }` (bad/expired JWT)

Admin accounts are created via CLI: `npm run create-admin <username> <password>`

---

## System Status

### Get System Status

```
GET /api/admin/status
```

Overview of worker state, replay count, job breakdown, disk usage, and active resource limits.

**Response** `200`

```json
{
  "compressor": {
    "running": true,
    "currentJobId": "6651a..."
  },
  "uploader": {
    "running": true,
    "currentJobId": null
  },
  "replays": 542110,
  "jobs": {
    "pending": 2,
    "processing": 1,
    "compressed": 1,
    "completed": 47,
    "failed": 1,
    "cancelled": 3
  },
  "tempDisk": {
    "usedBytes": 52428800,
    "usedMb": 50,
    "freeBytes": 107374182400,
    "freeMb": 102400,
    "entries": 2
  },
  "limits": {
    "jobMaxConcurrentPerClient": 3,
    "jobMaxPendingTotal": 50,
    "jobTimeoutMinutes": 60,
    "slpzTimeoutMinutes": 30,
    "minFreeDiskMb": 2048
  },
  "dbSizeBytes": 1073741824,
  "uptime": 86400.5
}
```

| Field | Type | Description |
|---|---|---|
| `compressor.running` | boolean | Whether the compressor worker is active. |
| `compressor.currentJobId` | string \| null | Job ID currently being compressed, or null. |
| `uploader.running` | boolean | Whether the uploader worker is active. |
| `uploader.currentJobId` | string \| null | Job ID currently being uploaded, or null. |
| `replays` | number | Total replay count (all replays, not filtered). |
| `jobs` | object | Job counts keyed by status. |
| `tempDisk.usedBytes` | number | Bytes used in job temp directory. |
| `tempDisk.usedMb` | number | MB used (rounded). |
| `tempDisk.freeBytes` | number | Bytes free on the temp partition. |
| `tempDisk.freeMb` | number | MB free (rounded). |
| `tempDisk.entries` | number | Number of files/directories in the temp dir. |
| `limits` | object | Currently active resource limits (from config/env vars). |
| `dbSizeBytes` | number | MongoDB data size in bytes. |
| `uptime` | number | Server uptime in seconds. |

---

## Worker Control

Job processing is split into two independent workers:

- **Compressor** — picks up `pending` jobs, queries replays, compresses into a `.tar` bundle, and sets status to `compressed`.
- **Uploader** — picks up `compressed` jobs, uploads the bundle to R2, and sets status to `completed`.

**Job lifecycle:** `pending → processing → compressing → compressed → uploading → completed`

### Compressor Control

#### Start Compressor

```
POST /api/admin/worker/compressor/start
```

**Response** `200` — `{ "message": "Compressor started" }` or `{ "message": "Compressor already running" }`

#### Stop Compressor

```
POST /api/admin/worker/compressor/stop
```

**Response** `200` — `{ "message": "Compressor stopped" }` or `{ "message": "Compressor already stopped" }`

### Uploader Control

#### Start Uploader

```
POST /api/admin/worker/uploader/start
```

**Response** `200` — `{ "message": "Uploader started" }` or `{ "message": "Uploader already running" }`

#### Stop Uploader

```
POST /api/admin/worker/uploader/stop
```

**Response** `200` — `{ "message": "Uploader stopped" }` or `{ "message": "Uploader already stopped" }`

### Worker Status

```
GET /api/admin/worker/status
```

**Response** `200`

```json
{
  "compressor": {
    "running": true,
    "currentJobId": "6651a..."
  },
  "uploader": {
    "running": true,
    "currentJobId": null
  }
}
```

---

## Job Management

Admin job management has full access to all jobs regardless of `createdBy`.

### View Queue

```
GET /api/admin/jobs/queue
```

View the current job processing queue — the active job (if any) and all pending jobs in processing order.

**Response** `200`

```json
{
  "activeJob": {
    "_id": "6651a...",
    "status": "compressing",
    "filter": { "p1ConnectCode": "AKLO#0" },
    "priority": 0,
    "replayCount": 342,
    "progress": { "step": "compressing", "filesProcessed": 150, "filesTotal": 342, "bytesUploaded": null, "bytesTotal": null }
  },
  "queue": [
    {
      "_id": "6651b...",
      "status": "pending",
      "filter": { "p1ConnectCode": "MANG#0" },
      "priority": 0,
      "estimatedProcessingTime": 45,
      "createdAt": "2024-06-01T12:10:00.000Z"
    }
  ]
}
```

Queue is sorted by `priority` ascending (lower = first), then `createdAt` ascending.

---

### Reorder Queue

```
PUT /api/admin/jobs/reorder
```

Bulk reorder pending jobs. Assigns priority values 0, 1, 2... in the order provided. All referenced jobs must be pending.

**Request Body**

```json
{
  "jobIds": ["6651b...", "6651c...", "6651d..."]
}
```

| Field | Type | Description |
|---|---|---|
| `jobIds` | string[] | Job IDs in desired processing order. |

**Response** `200` — `{ "message": "Reordered 3 jobs" }`

**Response** `400` — `{ "error": "All jobs must be pending to reorder" }` or `{ "error": "One or more job IDs not found" }`

---

### List All Jobs

```
GET /api/admin/jobs
```

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | Filter by job status (`pending`, `processing`, `compressing`, `compressed`, `uploading`, `completed`, `failed`, `cancelled`). |
| `createdBy` | string | — | Filter by client ID. |
| `startDate` | string | — | ISO 8601 date. Jobs created on or after. |
| `endDate` | string | — | ISO 8601 date. Jobs created on or before. |
| `page` | number | `1` | Page number. |
| `limit` | number | `50` | Results per page, max `200`. |

**Response** `200`

```json
{
  "jobs": [
    {
      "_id": "6651a...",
      "status": "completed",
      "filter": {
        "p1ConnectCode": "AKLO#0",
        "p1CharacterId": "20"
      },
      "createdBy": "uuid-string",
      "replayIds": ["...", "..."],
      "replayCount": 342,
      "estimatedSize": 83886080,
      "bundlePath": "/tmp/jobs/6651a.tar",
      "bundleSize": 10836352,
      "r2Key": "jobs/6651a.tar",
      "progress": null,
      "error": null,
      "startedAt": "2024-06-01T12:00:01.000Z",
      "createdAt": "2024-06-01T12:00:00.000Z",
      "updatedAt": "2024-06-01T12:05:00.000Z",
      "completedAt": "2024-06-01T12:05:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 53,
    "pages": 2
  }
}
```

Note: Admin list returns the full job document including `r2Key`, `bundlePath`, `replayIds`, and `createdBy`. When filtering by `status=pending`, results are sorted by `{ priority: 1, createdAt: 1 }` (queue order) instead of newest-first.

---

### Get Job Details

```
GET /api/admin/jobs/:id
```

Returns the full job document (all fields).

**Response** `200` — Full job document (same shape as list items above).

**Response** `404` — `{ "error": "Job not found" }`

---

### Update Job

```
PATCH /api/admin/jobs/:id
```

Edit a job's filter (only if `pending`) or change its status.

**Request Body**

```json
{
  "filter": {
    "p1ConnectCode": "MANG#0",
    "stageId": "31"
  },
  "status": "pending",
  "priority": -1
}
```

| Field | Type | Description |
|---|---|---|
| `filter` | object | New filter. Only allowed when job status is `pending`. |
| `status` | string | Set status to any valid value: `pending`, `processing`, `compressing`, `compressed`, `uploading`, `completed`, `failed`, `cancelled`. |
| `priority` | integer | Queue priority. Lower values are processed first. Default is `0`. Only allowed when job status is `pending`. |

All fields are optional.

**Response** `200` — Updated job document.

**Response** `400` — `{ "error": "Can only edit filter on pending jobs" }` or `{ "error": "Invalid status..." }`

**Response** `404` — `{ "error": "Job not found" }`

---

### Delete Job

```
DELETE /api/admin/jobs/:id
```

Cancel a job and clean up all associated resources (R2 object + local temp files).

**Response** `200` — `{ "message": "Job cancelled and cleaned up" }`

**Response** `404` — `{ "error": "Job not found" }`

---

### Retry Job

```
POST /api/admin/jobs/:id/retry
```

Reset a `failed` or `cancelled` job back to `pending` so it gets picked up again. Clears error, progress, R2 key, bundle data, and replay IDs. Re-runs the count and size aggregation to set fresh `replayCount`, `estimatedSize`, and `estimatedProcessingTime`.

**Response** `200`

```json
{
  "jobId": "6651a...",
  "status": "pending"
}
```

**Response** `400` — `{ "error": "Can only retry failed or cancelled jobs" }`

**Response** `404` — `{ "error": "Job not found" }`

---

## Temp Storage

### Clean Orphaned Temp Files

```
POST /api/admin/temp/cleanup
```

Remove orphaned temp directories and tar files from the job temp directory. Files older than `maxAgeHours` are deleted. Orphans are typically left behind by crashes or killed processes.

This runs automatically on server startup (24h threshold), but can also be triggered manually.

**Request Body**

```json
{
  "maxAgeHours": 24
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `maxAgeHours` | number | `24` | Delete temp entries older than this. |

**Response** `200`

```json
{
  "cleaned": 3,
  "remaining": 1,
  "usedMb": 50,
  "freeMb": 102400
}
```

| Field | Type | Description |
|---|---|---|
| `cleaned` | number | Number of orphaned entries removed. |
| `remaining` | number | Entries still in the temp dir. |
| `usedMb` | number | MB used after cleanup. |
| `freeMb` | number | MB free on the temp partition. |

---

## Submissions

Community replay uploads go through an airlock (staging area) before being reviewed and added to the main archive. All submission endpoints require admin auth.

### Upload Replays

```
POST /api/submissions/upload
```

Upload a `.slp` or `.zip` file containing replay(s). The request body should be the raw file bytes (not multipart form data).

**Headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/octet-stream` |
| `X-Filename` | Yes | Original filename (e.g. `replays.zip`). Must end in `.slp` or `.zip`. |
| `X-Submitted-By` | No | Who is submitting (connect code, name, etc). |

**Response** `202`

```json
{
  "uploadId": "6651a...",
  "filename": "replays.zip",
  "size": 1048576,
  "status": "extracting"
}
```

The upload is processed asynchronously. If a `.zip` is uploaded, individual `.slp` files are extracted and each becomes a separate submission.

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

**Response** `200` — Single upload object.

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
| `limit` | number | `50` | Results per page, max `200`. |

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

**Response** `200` — Single submission object.

**Response** `404` — `{ "error": "Submission not found" }`

---

### Approve Submission

```
POST /api/submissions/:id/approve
```

Approve a pending submission. Moves the file from the airlock into the main archive under the `uploads/` folder and creates a replay record.

**Response** `200`

```json
{
  "status": "approved",
  "replayId": "6651a..."
}
```

**Response** `400` — `{ "error": "Submission already approved" }` (or `rejected`)

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

**Response** `400` — `{ "error": "Submission already rejected" }` (or `approved`)

**Response** `404` — `{ "error": "Submission not found" }`
