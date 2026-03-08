# Dead Code & Cleanup — Lunar Melee Frontend

## Files to Delete

| File | Reason |
|------|--------|
| `src/components/test.tsx` | Empty file, 0 bytes |
| `src/components/SlippiParser.tsx` | Stub component, never imported |
| `src/pages/api/hello.ts` | Next.js boilerplate, returns `{ name: 'John Doe' }` |
| `src/pages/api/auth/signup.ts` | Non-functional stub, broken imports |
| `jsconfig.json` | Duplicate of tsconfig.json, ignored in TS projects |
| `src/styles/Checkout.module.scss` | No checkout page exists |
| `src/styles/Home.module.scss` | index.tsx just re-exports database |
| `public/favicon_old(unused).ico` | Stale file |

## Add to .gitignore

- `tsconfig.tsbuildinfo` — build artifact currently tracked

## Dead Code in Live Files

- `api/auth/[...nextauth].ts:196-247` — unused `html()` and `text()` functions from removed email template
- `Navbar.tsx` — unused `isCartPage`, `cart`, `cartCount`, `size` state (cart feature removed)
- `bans.tsx:83` — unused `editForm` state
- `context/state.tsx` — only provides shopping cart context, vestigial

## Heavy Duplication (Refactor Candidates)

- `signin.tsx` / `createAccount.tsx` — ~95% identical, should share a component
- `upload.tsx` / `secret_upload.tsx` — same onDrop, title animation, rendering
- `download.tsx` / `admin.tsx` — duplicated `formatBytes`, `formatEta`, `timeAgo`, `badgeClass`, `statusLabel`, `isActiveStatus`, `summarizeFilters`
- `utils/handler.ts` + `next-connect` — only used by dead signup.ts, can remove both
