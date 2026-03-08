# Frontend Audit TODO

## Priority 1 — Critical Security
- [ ] Add auth to `updateTag` endpoint
- [ ] Fix path traversal in file/delete/deleteAttachment endpoints (use `path.resolve` + trailing sep)
- [ ] Validate `jobId`/`replayId` format before URL interpolation (prevent SSRF)
- [ ] HTML-escape OAuth error params (reflected XSS)
- [ ] Remove `NEXT_PUBLIC_ADMIN_EMAILS`, use server-only `ADMIN_EMAILS`

## Priority 2 — High Security
- [ ] Add CSRF state validation to OAuth callbacks (YouTube, Twitch, Patreon)
- [ ] Add admin auth to OAuth callback endpoints
- [ ] Stop rendering OAuth tokens in browser HTML (write server-side instead)
- [ ] Add file size limit to multer upload config
- [ ] Add file type validation (fileFilter) to uploads
- [ ] Add auth check to ban file download endpoint
- [ ] Replace regex HTML sanitization with DOMPurify in aiStory.ts
- [ ] Return generic error in handler.ts instead of `err.toString()`
- [ ] Allowlist req.body fields before forwarding to upstream API

## Priority 3 — Medium Security
- [ ] Sanitize Content-Disposition filename
- [ ] Don't trust X-Forwarded-For unconditionally
- [ ] Add rate limiting to AI chat, analytics, download create endpoints
- [ ] Clear cached admin JWT on 401 from upstream
- [ ] Validate ObjectId format before `new ObjectId(id)` in bans API

## Priority 4 — React / Code Quality Fixes
- [ ] Move router.push() into useEffect (account, signin, createAccount)
- [ ] Fix duplicate sign-in toast (Navbar vs Toaster)
- [ ] Fix missing `loading` dep in admin.tsx useCallback
- [ ] Fix stale closure in download.tsx polling useEffect
- [ ] Replace Math.random() key fallback in database.tsx
- [ ] Remove console.log from production code (account, GameCard, updateTag)
- [ ] Remove testFiles array from upload.tsx production bundle

## Priority 5 — Cleanup
- [ ] Delete dead files: test.tsx, SlippiParser.tsx, hello.ts, signup.ts, jsconfig.json, Checkout.module.scss, Home.module.scss, favicon_old(unused).ico
- [ ] Add tsconfig.tsbuildinfo to .gitignore
- [ ] Remove unused deps: bcrypt, validator
- [ ] Move eslint/eslint-config-next to devDependencies
- [ ] Remove dead code: unused html/text functions in nextauth, unused state in Navbar/bans
- [ ] Remove unused CSS classes across style modules
- [ ] Clean up globals.css empty :root variables

## Priority 6 — Refactoring (when time allows)
- [ ] Extract shared auth form component (signin + createAccount)
- [ ] Extract shared upload logic (upload + secret_upload)
- [ ] Extract shared utils (formatBytes, formatEta, timeAgo, etc.) from download/admin
- [ ] Extract shared .main/.mainContent layout styles
- [ ] Extract shared status badge styles
- [ ] Extract shared filter form styles
- [ ] Extract shared view toggle component (bans + banDetail)
- [ ] Enable TypeScript strict mode (incrementally)
