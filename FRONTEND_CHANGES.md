# Frontend Changes Needed — Pin / Unpin Bundles (2026-06-02)

## Context

Download bundles are now **ephemeral by default**. About 3 days after a job
completes, its bundle is auto-deleted from storage and the job's `downloadReady`
flips to `false`. To keep a bundle forever, an **admin** can **pin** it (and
**unpin** it to let it expire again).

This is **admin-only** — regular users do not pin anything, and the public
download flow is unchanged. The backend is fully implemented; the only frontend
work is adding Pin/Unpin controls to the **admin** jobs/bundles UI.

---

## 1. What to build

In the admin panel, wherever you list jobs (from `GET /api/admin/jobs`) or show a
job's detail, add a Pin/Unpin toggle on each **completed** bundle:

- `pinned === true`  → show **"Unpin"** (and ideally a "📌 Permanent" badge). Click → call unpin.
- `pinned === false` → show **"Pin"**. Click → call pin.
- Only enable the control when the bundle is actually downloadable
  (`status === "completed"` **and** `r2Key`/`downloadReady` present). Hide or
  disable it otherwise — you can't pin a bundle that has already expired or never finished.

On a successful call, update the row from the response's `pinned` value (or refetch the job).

---

## 2. New endpoints (the only API additions)

Both require the same admin auth you already send: `Authorization: Bearer <token>`.

### Pin

```
POST /api/admin/jobs/:id/pin
```

| Status | Body |
|---|---|
| `200` | `{ "jobId": "...", "pinned": true, "r2Key": "archive/....zip" }` |
| `400` | `{ "error": "Only completed bundles with a live download can be pinned" }` |
| `404` | `{ "error": "Job not found" }` |

### Unpin

```
POST /api/admin/jobs/:id/unpin
```

| Status | Body |
|---|---|
| `200` | `{ "jobId": "...", "pinned": false, "r2Key": "jobs/....zip" }` |
| `404` | `{ "error": "Job not found" }` |

Both are also subject to the standard admin `401` (not authenticated) and `429`
(admin mutation rate limit) responses, same as other admin mutations.

```js
async function setPinned(jobId, pinned, adminToken) {
  const action = pinned ? "pin" : "unpin";
  const res = await fetch(`/api/admin/jobs/${jobId}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json(); // { jobId, pinned, r2Key }
}
```

---

## 3. New `pinned` field on job objects

Every job object now includes a boolean **`pinned`**. Use it to render toggle state. It appears in:

- `GET /api/admin/jobs` (list) and `GET /api/admin/jobs/:id` (full document)
- `GET /api/jobs/:id` (public job status) — additive; ignore if you don't need it

No existing fields changed shape.

---

## 4. UI copy / behavior notes

- **Pin** = "keep this download permanently." **Unpin** = "let it expire (~3 days
  after completion; may be deleted on the next cleanup pass if it's already older than that)."
- The pin/unpin operation relocates the object between storage tiers server-side.
  It's idempotent, and the download URL keeps working the whole time.
- Idempotent means double-clicking Pin is harmless.

---

## 5. What does NOT change

- Job creation, polling, download, and cancel are unchanged.
- The public (non-admin) user flow is unchanged — a pinned bundle simply stays
  downloadable indefinitely instead of expiring.
- These endpoints + the `pinned` field are purely additive. All existing calls keep working.

---
---

# Analytics page — new "Top Clients" endpoint (2026-06-03)

A new admin analytics endpoint surfaces the most active clients (for power-user
and abuse/scraping detection). Add it to the **admin analytics page** alongside
the existing overview / activity / top-searches widgets.

> Reminder: every `/api/admin/analytics/*` endpoint is **admin-only** — send the
> admin JWT (`Authorization: Bearer <token>`). The analytics page must live
> inside the authenticated admin area or these all return `401`.

## Endpoint

```
GET /api/admin/analytics/top-clients?startDate=&endDate=&limit=20
```

| Query param | Type | Default | Notes |
|---|---|---|---|
| `startDate` | ISO date | — | optional, events on/after |
| `endDate` | ISO date | — | optional, events on/before |
| `limit` | number | `20` | 1–100 |

**Response `200`:**

```json
{
  "clients": [
    { "clientId": "f178efca-…", "searches": 142, "downloads": 3,
      "totalBytes": 6868114349, "totalReplays": 19751, "totalEvents": 145 },
    { "clientId": null, "searches": 206, "downloads": 0,
      "totalBytes": 0, "totalReplays": 0, "totalEvents": 206 }
  ]
}
```

Sorted by `totalEvents` (searches + downloads) descending.

## UI notes

- Render as a table: client, searches, downloads, data downloaded (`totalBytes`,
  format as MB/GB), replays, total events.
- **`clientId: null`** means requests sent with **no `X-Client-Id` header** — all
  collapsed into one row. Label it "Anonymous / no client ID". A large `null`
  row with many searches and zero downloads is a classic header-less-scraper
  signal, so it's worth making visually distinct.
- Consider linking a row to the existing **List Search/Download Events**
  endpoints filtered by that `clientId` (`?clientId=…`) for drill-down.

```js
const res = await fetch(`/api/admin/analytics/top-clients?limit=20`, {
  headers: { Authorization: `Bearer ${adminToken}` },
});
const { clients } = await res.json();
```

---
---

## Previous changes (already deployed) — Unified Job Filters (2026-02-25)

> Kept for reference. These were shipped earlier; no action needed unless your
> frontend still uses the old shapes.

Job creation uses the same p1/p2 filter format as replay search. The simple filter fields (`connectCode`, `characterId` as number, `stageId` as number) are gone. The separate `/api/jobs/estimate` endpoint was removed.

- **`POST /api/jobs`** uses the p1/p2 string-filter format (e.g. `p1ConnectCode`, `p1CharacterId`, `stageId`), matching `GET /api/replays` and `POST /api/replays/estimate`.
- **`POST /api/jobs/estimate`** was removed (returns 404). Use `POST /api/replays/estimate` with the same filter format.
- Job objects (`GET /api/jobs`, `/api/jobs/:id`, `/api/jobs/bundles`) return the new `filter` shape.
- `POST /api/replays/estimate` and `POST /api/jobs` accept optional `maxFiles` (number) and `maxSizeMb` (number) limit fields, stored on the job's `filter` and echoed in responses.
- `X-Client-Id` header, job polling, download, cancel, and the status lifecycle (`pending → processing → compressing → compressed → uploading → completed`) are unchanged.
