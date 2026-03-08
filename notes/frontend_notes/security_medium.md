# Medium Security Issues — Lunar Melee Frontend

## 19. Content-Disposition Header Injection
**File:** `src/pages/api/download.ts` (line 115)
**Status:** Open

Filename from upstream response injected into header without sanitizing `"` or newlines.

---

## 20. X-Forwarded-For Trusted Blindly
**Files:** `src/pages/api/download.ts`, `src/utils/analyticsServer.ts`
**Status:** Open

Attacker can spoof IP for job ownership (cancel others' downloads) and analytics poisoning.

---

## 21. No Rate Limiting on Any Endpoint
**Status:** Open

Most concerning: AI chat (OpenAI cost), analytics (data poisoning), download create (resource exhaustion).

---

## 22. Cached Admin JWT Never Cleared on 401
**File:** `src/pages/api/admin.ts`
**Status:** Open

If token is revoked upstream, Next.js keeps using it until expiry.

**Fix:** Clear cached token on 401 response from upstream.

---

## 23. allowDangerousEmailAccountLinking Enabled
**File:** `src/pages/api/auth/[...nextauth].ts` (line 54)
**Status:** Open

Intentional UX choice but allows any provider with matching email to link accounts.
