# Frontend Changes Needed — Unified Job Filters (2026-02-25)

Job creation now uses the same p1/p2 filter format as replay search. The simple filter fields (`connectCode`, `characterId` as number, `stageId` as number) are gone. The separate `/api/jobs/estimate` endpoint has been removed.

---

## 1. New Filter Format on `POST /api/jobs`

**Old format (removed):**

```json
{
  "connectCode": "AKLO#0",
  "characterId": 20,
  "stageId": 31,
  "startDate": "2024-01-01",
  "endDate": "2024-12-31"
}
```

**New format:**

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

All fields are strings (including IDs — comma-separated for multiple values). This is the same format used by `GET /api/replays` query params and `POST /api/replays/estimate`.

The frontend can now pass the exact same filter object to both estimate and job creation.

---

## 2. `POST /api/jobs/estimate` Removed

This endpoint no longer exists (returns 404). Use `POST /api/replays/estimate` instead — it accepts the same filter format and returns more data (ETA, total duration).

**Before:**

```js
const estimate = await fetch("/api/jobs/estimate", {
  method: "POST",
  body: JSON.stringify({ connectCode: "AKLO#0" }),
});
```

**After:**

```js
const estimate = await fetch("/api/replays/estimate", {
  method: "POST",
  body: JSON.stringify({ p1ConnectCode: "AKLO#0" }),
});
```

---

## 3. Filter Shape in Job Responses Changed

Job objects returned by `GET /api/jobs`, `GET /api/jobs/:id`, and `GET /api/jobs/bundles` now have the new filter shape:

```json
{
  "filter": {
    "p1ConnectCode": "AKLO#0",
    "p1CharacterId": "20"
  }
}
```

Update any UI that displays the job filter (e.g. "Downloading replays for AKLO#0") to read from the new field names.

---

## 4. Error Responses (Unchanged)

These still work the same way from the previous update:

```
201 → Job created
400 → No replays match / At least one filter field is required
429 → Per-client job limit reached
503 → Queue full
```

---

## 5. New: `maxFiles` and `maxSizeMb` Limit Fields

Both `POST /api/replays/estimate` and `POST /api/jobs` now accept two optional numeric fields:

| Field | Type | Description |
|---|---|---|
| `maxFiles` | number | Cap the number of replays included in the download. |
| `maxSizeMb` | number | Cap the total raw file size (in MB) included in the download. |

When set, the estimate endpoint returns capped counts/sizes, and the job will only include replays within those limits. `maxFiles` is applied first, then `maxSizeMb` within that.

```json
{
  "p1ConnectCode": "AKLO#0",
  "maxFiles": 500,
  "maxSizeMb": 1024
}
```

These fields are stored on the job's `filter` object and appear in job responses.

---

## 6. Everything Else Unchanged

- `X-Client-Id` header works the same way
- Job polling (`GET /api/jobs/:id`) works the same way
- Download (`GET /api/jobs/:id/download`) works the same way
- Cancel (`DELETE /api/jobs/:id`) works the same way
- Job status lifecycle is unchanged: `pending → processing → compressing → compressed → uploading → completed`
