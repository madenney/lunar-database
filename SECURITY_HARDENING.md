# Security Hardening Plan

**Status:** planned — execute during the migration off the daily-driver (belphegor)
onto the worker / a dedicated low-use box, after the release video drops.
**Verdict (2026-06-19 review):** ACCEPTABLE WITH HARDENING. The *exposure* design is
good (MongoDB bound to 127.0.0.1, only public door is the Cloudflare tunnel, no
port-forwarding). The gaps are **recoverability** and **blast-radius control**.
Not invincible even after all fixes — see "Residual risk".

## Verified state at review time (belphegor)
- Ubuntu 24.04, MongoDB 8.0.15, bind 127.0.0.1, **NO auth** (URI has no creds).
- API runs as **`matt`** (human acct), **no systemd hardening active** (setup.sh never run).
- **No host firewall.** Samba (smbd) live on 0.0.0.0:445/139; stray services on
  0.0.0.0:3003/7332/8731/8765. Tailscale present (good). 27017/3002 are localhost ✓.
- **No LUKS / no encryption at rest.** `~/.ssh/id_ed25519` (→worker) has **no passphrase**.
- **Zero MongoDB backups** of any kind. NFS exported to whole 192.168.1.0/24, sec=sys.
- Good: `JWT_SECRET` is a real 64-char secret; `.env` is 0600 matt:matt; no secrets in
  git; unattended-upgrades on.

## MUST-FIX (in order; do before relying on the data)
1. **Backups** — nightly encrypted `mongodump` → separate B2 bucket with **Object Lock +
   versioning** (separate key the app host doesn't hold) + one **offline encrypted USB**
   rotated monthly. Store a SHA-256 next to each dump; weekly re-download + verify
   (detects poisoning). **Test `mongorestore` into a scratch DB monthly.** Currently ZERO
   backups = one ransomware/`rm`/corruption event is permanent total loss.
2. **Privilege separation** — run `deploy/setup.sh`; run API as `lm-database` (not `matt`);
   deploy the hardened unit (`NoNewPrivileges`, `ProtectHome`, `ProtectSystem=strict`,
   `PrivateTmp`, `ReadWritePaths`=temp only); move SSH key + B2 creds out of that user's reach.
3. **MongoDB auth** — `security.authorization: enabled`; users: `admin` (root),
   `lm_app` (readWrite lm-database-v2 only), `lm_backup` (read), `lm_ro` (read). App uses
   `lm_app` via MONGODB_URI. Disable server-side JS (`security.javascriptEnabled: false`).
4. **Host firewall + close LAN services** — ufw/nftables **default-deny inbound**; allow only
   SSH (LAN+Tailscale) and what's needed. `systemctl disable --now smbd nmbd` (or scope to
   named IPs); audit/kill the stray 0.0.0.0 ports.
5. **Lock worker access** — restrict belphegor→worker SSH key in worker `authorized_keys`
   (`from="192.168.1.211",command="...",no-pty`) + passphrase; lock NFS export to
   belphegor's IP only with `root_squash`; firewall NFS (111/2049) to that IP.
6. **Scope B2 keys** — app key = single bucket, no delete/key-mgmt; backups in a **separate
   Object-Locked bucket** written by a separate key the app host never holds.

## STRONGLY RECOMMENDED (after must-fixes)
- **Migrate DB+API off the daily-driver** onto the worker / dedicated box (no Spotify/Discord/
  Samba/gaming sharing the trust boundary). This is the biggest structural win and the
  trigger event for this whole plan.
- LUKS full-disk encryption both machines (TPM2+PIN so unattended reboot works).
- Cloudflare Access (or Tailscale-only) in front of `/api/admin/*`.
- Finish email alerts (`GMAIL_APP_PASSWORD`) + monitoring: mongod auth failures, admin
  logins, dropDatabase/large deletes, new listening ports, backup-job failure, disk <10%,
  SMART. Ship logs off-box.
- Reset admin password (unknown) to 30+ char random; patch + verify RAID/SMART on worker.
- Verify NoSQL-injection path: cast user filter values to primitives in
  `buildReplaySearchQuery`; reject objects where scalars expected (test `?field[$ne]=`).

## Verification commands (own machines only)
```bash
ss -tlnp | grep -E '27017|3002'                 # DB must be 127.0.0.1 only
mongosh --eval 'db.adminCommand({listDatabases:1})'  # must FAIL without creds
sudo ufw status verbose                          # default deny incoming
nc -zv -w3 192.168.1.211 27017                   # from another LAN box: must refuse
ps -o user= -C node                              # expect lm-database, not matt
mongorestore --gzip --archive=latest.gz --nsFrom 'lm-database-v2.*' --nsTo 'restore_test.*'
curl -s -o /dev/null -w '%{http_code}\n' https://api.lunarmelee.com/api/admin/queue  # gated at edge
```

## Residual risk (NOT invincible, even after all of the above)
- Malware on the host running as the service user (mitigate: VM/container isolation, EDR).
- Node/dependency 0-day RCE as the service user (mitigate: priv-sep limits blast radius, npm audit).
- Stolen B2/Cloudflare/Tailscale *account* creds (mitigate: MFA on those accounts).
- Poisoned backup (mitigate: integrity hashes + offline copy + restore tests).
- Physical access / evil-maid (mitigate: LUKS, BIOS pw, no USB boot, screen lock).
- Operator error (mitigate: least-privilege users, tested restores).
