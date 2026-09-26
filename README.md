# lm-database

Self-hosted Slippi replay archive system for [lunarmelee.com](https://lunarmelee.com).

Crawls ~20TB of `.slp` replay files, indexes metadata into MongoDB, and serves an API for searching/filtering replays and requesting download bundles.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Home Machine                                           │
│                                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐    │
│  │ Crawler  │──▶│ MongoDB  │◀──│ Express API       │◀───┼──── Cloudflare Tunnel
│  └──────────┘   └──────────┘   │  /api/replays     │    │          │
│                                │  /api/jobs         │    │          │
│  ┌──────────┐                  │  /api/stats        │    │     lunarmelee.com
│  │ Job      │◀─────────────────│  /api/jobs/:id/dl  │    │     (Next.js on Linode)
│  │ Worker   │                  └──────────────────┘    │
│  └──────────┘                                           │
│       │                                                 │
│       ▼                                                 │
│  ┌──────────┐                                           │
│  │ Bundles  │  (.zip files served for download)         │
│  │ /data/   │                                           │
│  └──────────┘                                           │
└─────────────────────────────────────────────────────────┘
```

- **Crawler** — Walks the `.slp` directory tree, parses each file with `@slippi/slippi-js`, stores metadata in MongoDB
- **API** — Express server exposing replay search, job creation, job status, and bundle downloads
- **Job Worker** — Polls for pending download jobs, bundles matching replays into `.zip` files
- **Bundle Cache** — Completed bundles are kept for a configurable TTL, then cleaned up automatically

## Setup

```bash
# Install dependencies
npm install

# Copy env and configure
cp .env.example .env
# Edit .env with your MongoDB URI, SLP root directory, etc.

# Development
npm run dev

# Build & run
npm run build
npm start
```

## Crawling

Index your replay files:

```bash
# Uses SLP_ROOT_DIR from .env
npm run crawl

# Or specify a directory
npm run crawl -- /path/to/slp/files
```

The crawler skips files that are already indexed (by file path) and never follows
symlinks (the archive keeps ~1M flat-path links for replay_archiver; indexing them
would duplicate replays). Safe to re-run.

After every crawl, rebuild the player autocomplete summary, which the crawler does
not maintain:

```bash
npm run build-players
```

### Full-database download

The "Download Full DB" button serves one pre-built archive,
`b2:lm-replays/archive/lunar_db_full.zip`: every real replay's `.slpz` (raw `.slp`
where slpz can't compress it). It is a snapshot; the site shows its date, size and
replay count. Rebuild it on the worker after large imports:

```bash
nohup scripts/full-db/rebuild.sh > /dev/null 2>&1 &   # build → verify → upload → register
tail -f ~/Projects/worker/shared_folder_2/full_db/rebuild.log
```

The build writes to `shared_folder_2` (a different disk from the archive) and takes
a few hours; the upload takes days. The old archive keeps serving until the upload
completes. Rerunning after a failure reuses an unpublished build. The last step,
`npm run register-full-db -- --size BYTES --replays N --snapshot ISO_DATE`, updates
the pinned bundle record the site reads.

### Per-game stats

`extract-stats` fills the `gameStats` collection and writes per-conversion detail
files. Work is split into shards (replay-ID ranges in `statsShards`); any number of
machines can run it against the same MongoDB and detail directory, each claiming
shards with an expiring lease. A shard is done only once committed; a killed runner's
shard is reclaimed when its lease expires. Plan after each crawl, then run:

```bash
npm run extract-stats -- --plan [--shard-size 5000]
npm run extract-stats -- --detail-dir DIR [--workers N] [--max-shards N]
npm run extract-stats -- --status
```

Another machine needs the replay files (`SLP_ROOT_DIR`, `SLPZ_ARCHIVE_DIR`, read
only), the detail directory (read-write), `SLPZ_BINARY`, and `MONGODB_URI` reaching
the worker's MongoDB (for example through an SSH tunnel; don't expose MongoDB on
the LAN). Shards that fail three times stay `failed` in `--status` for inspection.

## API

### `GET /api/replays`

Search/filter replays. Query params:

| Param | Description |
|-------|-------------|
| `connectCode` | Player connect code (e.g. `MATT#123`) |
| `characterId` | Character ID number |
| `stageId` | Stage ID number |
| `startDate` | ISO date string, lower bound |
| `endDate` | ISO date string, upper bound |
| `page` | Page number (default 1) |
| `limit` | Results per page (default 50, max 200) |

### `GET /api/replays/:id`

Get a single replay by ID.

### `POST /api/jobs`

Create a download job. Body (JSON):

```json
{
  "connectCode": "MATT#123",
  "characterId": 2,
  "stageId": 31,
  "startDate": "2023-01-01",
  "endDate": "2024-01-01"
}
```

All fields optional. Returns `{ jobId, status }`.

### `GET /api/jobs/:id`

Check job status. Returns `{ jobId, status, bundleSize, error, createdAt, completedAt }`.

### `GET /api/jobs/:id/download`

Download the completed bundle (`.zip`).

### `GET /api/stats`

Returns `{ replays: count, jobs: { pending, processing, completed, failed } }`.

### `GET /health`

Returns `{ ok: true }`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGODB_URI` | `mongodb://localhost:27017/lm-database` | MongoDB connection string |
| `PORT` | `3000` | API server port |
| `SLP_ROOT_DIR` | `/data/slp` | Root directory of `.slp` files |
| `LUNAR_SERVICE_KEY` | empty | Shared secret identifying the website (same value in the website's env). When set, only the website may forward `X-Visitor-Ip` (per-visitor rate limits) or send `X-Client-Id`; other callers' identity headers are dropped. Deploy the website with the key before setting it here. |

## Project Structure

```
src/
  config.ts          — Environment config
  db.ts              — MongoDB connection
  index.ts           — Express app + worker startup
  models/
    Replay.ts        — Replay metadata schema
    Job.ts           — Download job schema
  routes/
    replays.ts       — Replay search/query endpoints
    jobs.ts          — Job CRUD + download endpoints
    stats.ts         — Stats endpoint
  services/
    slpParser.ts     — Parse .slp files via @slippi/slippi-js
    crawler.ts       — Directory walker + batch indexer
    bundler.ts       — Zip bundler + cleanup
  workers/
    jobWorker.ts     — Job queue processor
  scripts/
    crawl.ts         — CLI entry point for crawling
```

## Deployment (New Machine)

The API is exposed publicly via a Cloudflare Tunnel at `api.lunarmelee.com`. Everything you need to deploy on a fresh machine is in the `deploy/` folder.

### Prerequisites

- **Node.js** (v20+)
- **MongoDB** (v8.0) — installed and running as `mongod` systemd service
- **cloudflared** — [install instructions](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- **Tunnel credentials** — the `208535eb-4007-4e92-9d8d-4e3ab1c530c5.json` file (keep this secret, copy from previous machine)

### Step by step

```bash
# 1. Clone the repo
git clone https://github.com/madenney/lm-database.git
cd lm-database

# 2. Install dependencies and build
npm install
npm run build

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in paths, R2 keys, JWT secret, etc.
# Generate a JWT secret: openssl rand -hex 32

# 4. Copy tunnel credentials into place
# Get the credentials JSON from the old machine (~/.cloudflared/*.json)
# and put it at: ~/.cloudflared/208535eb-4007-4e92-9d8d-4e3ab1c530c5.json

# 5. Make sure MongoDB is running
sudo systemctl start mongod
sudo systemctl enable mongod

# 6. Run the setup script (installs systemd services, starts everything)
sudo bash deploy/setup.sh
```

### What the setup script does

1. Copies tunnel credentials to `/etc/cloudflared/credentials.json`
2. Copies tunnel config to `/etc/cloudflared/config.yml`
3. Installs two systemd services:
   - `lm-database-api` — the Express API server
   - `lm-database-tunnel` — the Cloudflare tunnel
4. Enables and starts both services (they auto-start on boot)

### Managing services

```bash
# Check status
sudo systemctl status lm-database-api
sudo systemctl status lm-database-tunnel

# View logs (live)
sudo journalctl -u lm-database-api -f
sudo journalctl -u lm-database-tunnel -f

# Restart after code changes
npm run build
sudo systemctl restart lm-database-api

# Stop everything
sudo systemctl stop lm-database-api lm-database-tunnel
```

### If you need to re-create the tunnel from scratch

This should only be necessary if you've lost the credentials file.

```bash
cloudflared tunnel login              # opens browser, pick lunarmelee.com
cloudflared tunnel create lm-database # creates new tunnel + credentials JSON
cloudflared tunnel route dns lm-database api.lunarmelee.com  # set DNS
# Then update the tunnel ID in deploy/cloudflared.yml and re-run setup
```

### Deploy folder contents

```
deploy/
├── cloudflared.yml              # Tunnel config (api.lunarmelee.com → localhost:3002)
├── lm-database-api.service      # systemd unit for Express API
├── lm-database-tunnel.service   # systemd unit for cloudflared
└── setup.sh                     # Installs everything, run with sudo
```

## Future Considerations

- **Database migration** — Schema is designed to be portable. If MongoDB can't handle hundreds of millions of records, migrate to Postgres.
- **Concurrency** — Job worker currently processes one job at a time. Can be scaled up.
