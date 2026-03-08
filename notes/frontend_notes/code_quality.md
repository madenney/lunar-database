# Code Quality Issues — Lunar Melee Frontend

## High

### 15. TypeScript strict: false
**File:** `tsconfig.json`

Disables all TS safety — nullchecks, implicit any, strict function types. Many files already have untyped params.

### 16. Unused Dependencies
**File:** `package.json`

- `bcrypt` — native C++ addon, never imported anywhere. Adds build complexity for nothing.
- `validator` — never imported. Project uses `email-validator` instead.

### 17. eslint in dependencies (not devDependencies)
**File:** `package.json`

`eslint` + `eslint-config-next` inflate production node_modules.

### 18. Dead signup endpoint
**File:** `src/pages/api/auth/signup.ts`

Broken imports, creates nothing, always returns 201. Delete it.

---

## Medium — React Issues

### 24. Router navigation during render
**Files:** `account.tsx:25`, `signin.tsx:12`, `createAccount.tsx:12`

`router.push()` called outside useEffect. Causes React warnings.

### 25. Duplicate sign-in toast
**File:** `Navbar.tsx:52-58`

Both Navbar and Toaster.tsx fire a toast on session change.

### 26. Missing loading in useCallback deps
**File:** `admin.tsx:488`

`loading` always reads as `true` inside fetchData, so `setPollError` never fires after initial load.

### 27. Stale closure in polling useEffect
**File:** `download.tsx:319`

`activeJobs` captured at effect time, not updated between polls.

### 28. Math.random() as React key
**File:** `database.tsx:291`

Fallback key destroys/recreates components every render.

### 29. title in useEffect deps
**Files:** `upload.tsx:116`, `secret_upload.tsx:96`

Interval recreated every 500ms. Works but wasteful.

### 30. testFiles array in production bundle
**File:** `upload.tsx:223-407`

~180 lines of test fixture shipped to users.

### 31-32. Pervasive any types and @ts-ignore
Multiple files. `any[]` for results, `as any` for session, `@ts-ignore` in ReplayRow/GameCard.

### 33. console.log left in production
**Files:** `account.tsx:26` (leaks user object), `GameCard.tsx:23`, `api/updateTag.ts:11`
