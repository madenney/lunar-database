# High Security Issues — Lunar Melee Frontend

## 6. Path Traversal Bypass in File Endpoints
**Files:** `src/pages/api/bans/file.ts`, `delete.ts`, `deleteAttachment.ts`
**Status:** Open

`startsWith` check fails if `FILE_STORAGE_PATH` doesn't end with `/`. E.g. `path.join('/data/files', '../files-secret/x')` → `/data/files-secret/x` still starts with `/data/files`.

**Fix:**
```typescript
const root = path.resolve(env.FILE_STORAGE_PATH) + path.sep;
const filePath = path.resolve(env.FILE_STORAGE_PATH, filename);
if (!filePath.startsWith(root)) { ... }
```

---

## 7. SSRF via jobId/replayId in URL Path
**Files:** `src/pages/api/download.ts` (lines 61, 71, 83, 107), `src/pages/api/admin.ts` (lines 89, 98, 119)
**Status:** Open

User-controlled values interpolated into upstream URL paths without validation. `../../admin/x` escapes the intended path segment.

**Fix:**
```typescript
if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return res.status(400).json({ error: 'Invalid jobId' });
```

---

## 8. Unvalidated req.body Forwarded Upstream
**Files:** `src/pages/api/download.ts` (lines 38-39, 51-52), `src/pages/api/admin.ts` (line 111)
**Status:** Open

`JSON.stringify(req.body)` sent directly to database API. Attacker can inject arbitrary fields.

**Fix:** Explicitly pick expected fields before forwarding.

---

## 9. No File Size Limit on Upload
**File:** `src/pages/api/bans/upload.ts` (lines 14-23)
**Status:** Open

Multer has no `limits` config. Disk-filling DoS possible.

**Fix:** `const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });`

---

## 10. No File Type Validation on Upload
**File:** `src/pages/api/bans/upload.ts`
**Status:** Open

No `fileFilter` — .html/.svg uploads served by file.ts = stored XSS.

**Fix:** Add fileFilter for safe MIME types, or always serve with `Content-Disposition: attachment`.

---

## 11. Unauthenticated File Download
**File:** `src/pages/api/bans/file.ts`
**Status:** Open

No auth check. Anyone who guesses banId + filename can download attachments.

---

## 12. Regex HTML Sanitization Bypassable
**File:** `src/utils/aiStory.ts` (lines 43-64)
**Status:** Open

`<iframe>`, unicode tricks, data URLs, CSS attacks all bypass regex-based sanitization.

**Fix:** Replace with DOMPurify (server-side with jsdom) or sanitize-html.

---

## 13. Full Error Details in HTTP Response
**File:** `src/utils/handler.ts` (line 9)
**Status:** Open

`err.toString()` sent to client — may leak stack traces, DB strings, internal paths.

**Fix:** Return generic error message in production.

---

## 14. XSS via document.write in Stream Popout
**File:** `src/pages/stream.tsx` (line 114)
**Status:** Open

`document.write` with URL interpolated into script tag. Currently hardcoded but dangerous if source changes.
