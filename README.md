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

The crawler skips files that are already indexed (by file path). Safe to re-run.

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
| `BUNDLES_DIR` | `/data/bundles` | Where to write bundle `.zip` files |
| `BUNDLE_MAX_AGE_HOURS` | `72` | How long to keep bundles before cleanup |
| `CRAWLER_BATCH_SIZE` | `100` | Number of replays to insert per batch |

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

## Future Considerations

- **Database migration** — Schema is designed to be portable. If MongoDB can't handle hundreds of millions of records, migrate to Postgres.
- **Concurrency** — Job worker currently processes one job at a time. Can be scaled up.
- **Cloudflare Tunnel** — Not configured here. Set up separately to expose the API.
