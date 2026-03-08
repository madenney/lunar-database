# Critical Security Issues — Lunar Melee Frontend

## 1. Unauthenticated Tag Update
**File:** `src/pages/api/updateTag.ts`
**Status:** Open

Anyone can POST any email + tag and overwrite any user's tag. No session check.

**Fix:** Add `requireUserEmail(req, res)` and verify the authenticated email matches the email being updated.

---

## 2. OAuth Callbacks — No CSRF / State Validation
**File:** `src/pages/api/costs.ts` (lines 336-398)
**Status:** Open

- Twitch: state param generated but never stored or verified in callback
- YouTube/Patreon: no state param at all
- Callbacks are completely unauthenticated

**Fix:** Store state in a server-side session or short-lived cookie before redirect, validate in callback. Add admin auth to callbacks.

---

## 3. OAuth Tokens Displayed in Browser HTML
**File:** `src/pages/api/costs.ts` (lines 254-304)
**Status:** Open

Refresh tokens rendered directly into HTML served to browser. Visible in browser history, proxy logs, cached by browser, accessible to extensions.

**Fix:** Require admin auth on callbacks. Write tokens server-side instead of displaying. Add `Cache-Control: no-store`.

---

## 4. Reflected XSS in OAuth Error Pages
**File:** `src/pages/api/costs.ts` (lines 254-280, 339-341)
**Status:** Open

`error` query param injected directly into HTML without escaping.

```
/api/costs?action=youtube-callback&error=<script>alert(document.cookie)</script>
```

**Fix:** HTML-encode the error parameter before inserting into template.

---

## 5. Admin Emails Leaked to Client Bundle
**File:** `src/config/admins.ts` (line 1)
**Status:** Open

`NEXT_PUBLIC_ADMIN_EMAILS` gets inlined into client-side JS by Next.js. Anyone can see admin emails in page source.

**Fix:** Remove `NEXT_PUBLIC_ADMIN_EMAILS` fallback, only use server-side `ADMIN_EMAILS`.
