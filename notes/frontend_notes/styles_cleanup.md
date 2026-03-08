# Styles Cleanup — Lunar Melee Frontend

## Duplicated Patterns to Extract

### .main / .mainContent (15+ files)
Every page independently defines these with slight variations:

| File | Background | Max-width | Width |
|------|-----------|-----------|-------|
| About, Account, Download, Software | `#181818` | `800px` | `85%` |
| Admin, Bans, Costs, Privacy | `#111` | `960px` | `90%` |
| Database | `#181818` | `1000px` | `85%` |
| Tutorials | `#181818` | `1500px` | `85%` |

**Fix:** Create shared layout classes in globals.css or a layout component with size variants.

### Status Badges (Admin + Download)
`.statusPending`, `.statusProcessing`, `.statusCompleted`, `.statusFailed`, `.statusCancelled` — near-identical colors in both files.

### View Toggle (Bans + BanDetail)
`.viewToggle`, `.viewToggleKnob`, `.viewToggleLabel`, etc. — copy-pasted entirely.

### Filter Forms (Database + Download)
`.filterSection`, `.filterRow`, `.filterItem`, `.filterLabel`, `.filterInput`, `.advancedToggle` — near-identical.

### @keyframes spin
Defined in 4 separate files (Admin, Costs, Database, Download).

---

## Unused CSS Classes

- **About.module.scss:** `.listElement`, `.title`, `.communitySection/Label/Links/Link/Icon`
- **Software.module.scss:** `.listElement`, `.centered`, `.list`, `.sectionTitle`
- **Tutorials.module.scss:** `.listElement`, `.centered`, `.link`, `.list`, `.title`, `.sectionTitle`
- **Upload.module.scss:** `.section`, `.sectionTitle`, `.button`, `.dropZoneActive`, `.anonInputs`, `.emailInput`, `.testButton`, `.uploadingMsgContainer`
- **Database.module.scss:** `.sectionTitle`, `.title`, `.downloadButton`, `.mobileMsg`, `.toolTip`
- **Download.module.scss:** `.sectionTitle`, `.estimate`, `.successBanner`, `.bundleList/Name/Desc/Info/Actions/Size`
- **Navbar.module.scss:** `.signIn`, `.accountButton`, `.mobileSignIn`, `.cartNotification`, `.mobileCartNotification`

Also: `.mobileProfile` is referenced in Navbar.tsx but not defined in the SCSS file.

---

## Empty Classes
`.listElement { }` defined identically in About, Software, and Tutorials — all unused.

## globals.css
`:root` blocks at lines 1-10 are completely empty. Body references undefined CSS variables (`--foreground-rgb`, `--background-end-rgb`, `--background-start-rgb`).

## Naming Inconsistency
- Most files use camelCase
- BanDetail uses snake_case for confidence levels (`.confidence_high`, `.confidence_medium`, `.confidence_low`)
