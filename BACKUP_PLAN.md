# Lunar Melee — Backup Plan (shared)

> **Canonical, cross-project plan.** An identical copy lives in both repos
> (`lunar_melee/BACKUP_PLAN.md` and `database/BACKUP_PLAN.md`) so the Claude
> instance in each project works from the same spec. Each project implements
> **only its own section** (§5 / §6) but both follow the same pattern (§3–4).
>
> Scope was deliberately right-sized: this is **durable, off-site, immutable,
> encrypted backups + a tested restore** — NOT cryptographic provenance
> (no hash-chains / OpenTimestamps / public ledger). For "show people my stats"
> we rely on the already-public stats pages + occasional Wayback Machine
> snapshots (§7). That's plenty for a community project.

## 1. Why
Today there are **zero backups** of either database. One `rm`, disk failure, bad
migration, or ransomware event = permanent total loss of the 3.17M-doc replay
index AND all usage/analytics history. This plan fixes that. Nothing here is
fancy — it's the boring, overdue table-stakes version.

## 2. Data map & ownership

| Domain | Mongo DB(s) | Owner repo | Backed up by |
|--------|-------------|------------|--------------|
| SLP index + DB usage stats | `lm-database-v2` (Replay, Job, Player, Submission, Upload, **DownloadEvent**, **SearchEvent**) | database | `database/scripts/backup_db.sh` (§6) |
| Website + lm-clipper stats | `lunar_melee_analytics` (`app_usage_events`, `page_view_events`, `page_events`, `event_counts`) + `lunar` (bans, costs) | lunar_melee | `lunar_melee/scripts/backup_lunar.sh` (§5) |

Rule: **each project dumps its own DB(s).** DB usage stats (DownloadEvent/
SearchEvent) ride along in `lm-database-v2`, so the database dump covers them for
free. Both DBs are on the same `mongod` (`localhost:27017`) today — so each
script must target its DB **by name**, never a full-instance dump (that would
double-cover and cross ownership).

**Out of scope here:** the ~2.3 TB of raw `.slp` files (separate big-data
decision — see database `SECURITY_HARDENING.md`), and any crypto-provenance.

## 3. Shared one-time setup (do once, before either script)
Owner: **matt** (manual), with either Claude assisting.

1. **B2 backup bucket** — create a NEW bucket (e.g. `lm-backups`), SEPARATE from
   the `lm-replays` download bucket. Enable **Object Lock** (immutability) +
   **versioning**. Recommended: Object Lock default retention **90 days**
   (governance mode for an escape hatch, or compliance for true WORM — matt's
   call). Add a lifecycle rule to expire noncurrent versions after ~1 year.
2. **Two app keys, least-privilege:**
   - `db-backup` key — restricted to bucket `lm-backups`, name prefix `db/`,
     capabilities: `listBuckets, listFiles, readFiles, writeFiles` (**no
     deleteFiles**, no key management).
   - `web-backup` key — same, name prefix `web/`.
   The app hosts must NOT hold a key that can delete backups.
3. **Encryption key** — `age-keygen -o backup-age.key`. Put the **public**
   recipient string in each project's env; store the **private** key OFFLINE
   (USB + password manager), never on the servers. (Dumps contain user emails /
   PII-ish analytics → encrypt at rest.)
4. **Dead-man's-switch** — create two checks at healthchecks.io (free):
   `lm-backup-db`, `lm-backup-web`. Each script pings its check on success; a
   MISSED ping emails matt. (Silence = failure caught.)
5. **Backup tooling on each host** — install `rclone` (B2 backend, recommended
   for backups) or AWS CLI (S3 endpoint). `age` for encryption. `mongodump`/
   `mongorestore` (mongo-database-tools).

## 4. The backup script pattern (identical both sides)
Each `backup_*.sh` is a standalone bash script (NOT wired into the app process),
`set -euo pipefail`, run by cron:

1. `mongodump --gzip --archive="$TMP/dump.gz" --db=<DB>` (one `--db` per target;
   use the read-only `lm_backup` Mongo user once auth is enabled — see §8).
2. **Encrypt:** `age -r "$AGE_RECIPIENT" -o "$TMP/dump.gz.age" "$TMP/dump.gz"`.
3. **Checksum:** `sha256sum dump.gz.age > dump.gz.age.sha256`.
4. **Upload** both files to `b2:lm-backups/<prefix>/YYYY/MM/DD_HHMMSS.gz.age`
   (and `.sha256`). Object Lock makes them immutable for the retention window.
5. **Prune local temp** (B2 lifecycle handles remote retention).
6. **Ping** the healthchecks URL on success. On any failure, the missed ping
   alerts; optionally also email via the project's mailer.

Retention (GFS, enforced by B2 lifecycle + Object Lock): daily 30d, weekly 1y,
monthly long-term.

## 5. lunar_melee work (this repo)
- New `scripts/backup_lunar.sh` following §4, dumping **`lunar` + `lunar_melee_analytics`**.
- **Also capture ban attachments**: the existing `scripts/backup_articles.sh`
  copies `airlock/files` (ban attachment files) — fold that into the new script
  (tar `airlock/files` → encrypt → upload under `web/files/`) so we don't lose
  that coverage, then retire/replace `backup_articles.sh`.
- Prefix: `web/`. Key: `web-backup`. Healthcheck: `lm-backup-web`.
- Env to add (`.env.local`): `BACKUP_B2_BUCKET`, `BACKUP_B2_PREFIX=web`,
  `BACKUP_B2_KEY_ID`, `BACKUP_B2_KEY`, `BACKUP_B2_ENDPOINT`, `BACKUP_AGE_RECIPIENT`,
  `BACKUP_HEALTHCHECK_URL`.
- Cron: `30 3 * * * /home/matt/Projects/lunar_melee/scripts/backup_lunar.sh >> logs/backup.log 2>&1`
- Optional: failure email via existing `src/utils/alertMail.ts` (`sendAlertEmail`).

## 6. database work (other repo)
- New `scripts/backup_db.sh` following §4, dumping **`lm-database-v2`**.
- This is the concrete implementation of `SECURITY_HARDENING.md` **MIGRATION #3**
  — keep it consistent with that doc.
- Prefix: `db/`. Key: `db-backup`. Healthcheck: `lm-backup-db`.
- Reuse the existing B2 know-how but with the SEPARATE backup bucket + key
  (do NOT reuse the `lm-replays` download key — that one can delete objects).
- Env to add: same var names as §5 but `BACKUP_B2_PREFIX=db`.
- Cron: `0 3 * * * /home/matt/Projects/database/scripts/backup_db.sh >> logs/backup.log 2>&1`
  (staggered 30 min before the web one to avoid `mongod` contention).
- `.slp` files: out of scope for this script — track separately.

## 7. "Show people my stats" (the cheap brag layer)
No crypto needed. Two free moves:
- Stats are already public (`/software` strip; public `GET /api/app-usage`). Keep
  them public.
- Periodically submit those URLs to the **Wayback Machine** (archive.org) so an
  independent, timestamped history of the numbers exists. Manual now and then is
  fine; can be a tiny weekly cron later. "Here's archive.org showing the growth"
  is convincing enough for a community tool.

## 8. Restore (a backup you haven't restored isn't a backup)
Runbook (document in each repo's README or this file):
```
rclone copy b2:lm-backups/<prefix>/<path>.gz.age ./       # fetch
sha256sum -c <path>.gz.age.sha256                          # verify integrity
age -d -i backup-age.key -o dump.gz <path>.gz.age          # decrypt (offline key)
mongorestore --gzip --archive=dump.gz \
  --nsFrom '<DB>.*' --nsTo 'restore_test.*'                # restore into scratch
# then sanity-check counts vs production
```
- **Do one manual restore right after the first successful backup** (both repos).
- Nice-to-have later: a monthly cron that does the above into a scratch DB and
  asserts row counts, alerting on mismatch.

## 9. Prereqs / dependencies / decisions
- **Mongo auth** is not yet enabled (database `SECURITY_HARDENING.md` MIGRATION
  #2). Backups work without it now (localhost, no-auth); once auth lands, switch
  the scripts to the read-only `lm_backup` user. Don't block initial backups on
  this — zero backups is the bigger risk.
- Decisions for matt: (a) Object Lock compliance vs governance + retention days;
  (b) one bucket + two prefixes [recommended] vs bucket-per-project;
  (c) rclone vs aws-cli; (d) age [recommended] vs gpg.

## 10. Checklist
- [ ] §3 B2 bucket + Object Lock + versioning + lifecycle (matt)
- [ ] §3 two prefix-scoped, no-delete app keys (matt)
- [ ] §3 age keypair; private key stored offline (matt)
- [ ] §3 two healthchecks.io checks (matt)
- [ ] §5 `lunar_melee/scripts/backup_lunar.sh` + cron + env (lunar_melee Claude)
- [ ] §6 `database/scripts/backup_db.sh` + cron + env (database Claude)
- [ ] §8 one manual restore test each (both)
- [ ] retire `backup_articles.sh` once `backup_lunar.sh` covers attachments
