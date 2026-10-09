# Lunar Melee API

> Generated from `packages/public-api/build.mjs` (the OpenAPI spec). Don't edit by hand: change the build script, then run `npm run build-api-spec && npm run sync-packages` from the repository root.

Developer docs: https://lunarmelee.com/developers · Spec: https://api.lunarmelee.com/openapi.json · Base URL: `https://api.lunarmelee.com`

## Introduction

The Lunar Melee API is free, read-only access to the Lunar database: over three million Slippi replays of Super Smash Bros. Melee from tournaments, netplay and Slippi ranked, with extracted stats, player profiles, tournament brackets and a searchable index of combos and edgeguards.

Everything the [Lunar Melee website](https://lunarmelee.com) shows comes from this API, and you can use it the same way: search games, read their stats, download replays one at a time or in bulk.

- **Base URL:** `https://api.lunarmelee.com`
- **Format:** JSON over HTTPS. Dates are ISO 8601 in UTC; durations are in frames (60 per second).
- **Authentication:** none. Bulk download jobs only need an `X-Client-Id` you make up yourself (see [Identifying your client](#client-id)).
- **Browsers:** CORS is open, so you can call the API from any web page.
- **Spec:** the whole API as [OpenAPI 3.1](https://api.lunarmelee.com/openapi.json), for Postman, Insomnia or code generators.

Lunar is free and runs on a single server. Please read [Fair use](#fair-use) before building something that sends a lot of requests.

## Quickstart

**1. Find games.** Fox vs Falco on Battlefield, tournament games only, newest first:

```bash
curl "https://api.lunarmelee.com/api/replays?p1CharacterId=2&p2CharacterId=20&stageId=31&source=tournament&limit=5"
```

Character and stage ids come from [Reference data](#reference): Fox is `2`, Falco `20`, Battlefield `31`.

**2. Read a game's stats.** Kills, openings, damage, neutral wins, combos, edgeguards and more:

```bash
curl "https://api.lunarmelee.com/api/replays/6abd2df68fe2062a80e9c4a5/stats"
```

**3. Download the replay.** Opens in Slippi Dolphin like any other `.slp` file:

```bash
curl -L --compressed -OJ "https://api.lunarmelee.com/api/replays/6abd2df68fe2062a80e9c4a5/download"
```

`-L` follows the redirect to our storage-backed copy, `--compressed` undoes the transfer compression and `-OJ` saves it under its original file name.

**4. Need thousands of games?** Don't loop over single downloads: ask for a [bulk download](#bulk-downloads) and get them all in one zip.

## Identifying your client

Reading needs no identification. Bulk download jobs do, so the API knows which jobs are yours: send an `X-Client-Id` header with a UUID (version 4 is fine) that you generate once and keep.

```bash
# Make one, keep it in your config:
python3 -c "import uuid; print(uuid.uuid4())"
```

- Use the same id for every request about your jobs: creating, listing, checking and cancelling.
- Anyone with your id can see and cancel your jobs, so keep it to yourself; it grants nothing else.
- Ids sent to the API live in their own space: they never collide with the website's visitors.

Please also set a descriptive `User-Agent` (e.g. `my-melee-tool/1.2 (+https://example.com)`), so we can get in touch if something you run misbehaves.

## Rate limits

Limits are per IP address, over a rolling window. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the window resets); a refused request gets `429` with code `rate_limited` and a `Retry-After` header.

| What | Limit |
|---|---|
| Everything together | 100 requests / minute |
| Replay search | 30 / minute |
| Single replay, replay stats | 60 / minute |
| Replay downloads | 30 / minute |
| Clip search | 30 / minute |
| Download estimates | 15 / minute |
| Creating download jobs | 5 / hour |
| Checking a job | 60 / minute |
| Player search and autocomplete | 30 / minute |
| Player profiles, top players, tournaments, sets, stats | 60 / minute |
| Full-database download links | 2 per 24 hours |

On a `429`, wait `Retry-After` seconds before trying again; don't retry in a tight loop. If your project needs more, ask in [Discord](https://discord.gg/ThjMCW3F4R).

## Errors

Errors are JSON with a plain-English `error`. Many also carry a machine-readable `code` (and sometimes extra fields): branch on `code`, not on the message, which may change.

```json
{ "error": "You already have 3 active job(s). Maximum is 3.", "code": "too_many_active_jobs", "limit": 3 }
```

| Code | Status | Meaning |
|---|---|---|
| `filter_required` | 400 | An estimate or job without any filter or limit. |
| `invalid_request` | 400 | Invalid search parameters (e.g. a clip search without a valid `type`). |
| `no_matches` | 400 | The filter matches no replays. |
| `invalid_client` | 400 | A missing or malformed `X-Client-Id` (it must be a UUID). |
| `cannot_cancel` | 400 | The job is past the point of cancelling. Extra: `status`. |
| `not_ready` | 400 | The bundle is not built yet. |
| `too_large` | 400 | The bundle would be bigger than one download may be. Extra: `estimatedBytes`, `maxBytes`. |
| `forbidden` | 403 | The job belongs to another client. |
| `not_found` | 404 | No job has this id. |
| `bundle_missing` | 410 | The job finished, but its bundle has expired from storage. |
| `rate_limited` | 429 | Too many requests. See `Retry-After`. |
| `too_many_active_jobs` | 429 | You already have the maximum number of jobs running. Extra: `limit`. |
| `queue_full` | 429 | The download queue is full. Extra: `pending`, `workSec`. |
| `fulldb_rate_limited` | 429 | The full-database download limit for your window is used up. Extra: `retryAfterSeconds`. |
| `download_cap` | 503 | Storage's daily download allowance is used up. Try again tomorrow. |
| `storage_busy` | 503 | Storage or replay serving is busy. Retry after `Retry-After` seconds. |

Other statuses: `404` for an unknown replay, player, tournament or set (`{ "error": "Replay not found" }`), and `500` when something fails on our side (safe to retry after a short wait).

## Pagination

List endpoints take `page` (from 1) and `limit`, and answer with a `pagination` object:

```json
{ "page": 2, "limit": 50, "total": 11507, "pages": 231 }
```

- Replay search allows `limit` up to 1,000. Its `total` may stop counting at a cap on very broad searches: then `totalCapped` is `true` and there are at least `total` matches.
- Clip search counts up to 10,000 (`capped: true` past that) and pages up to 400.
- Results are sorted newest first unless you choose otherwise, so new games appear on page 1: for a stable walk through a search, sort oldest first (`sort=startAt:1`) or narrow by date.

## Downloading replays

**One game:** `GET /api/replays/{id}/download` answers with the `.slp` file. Most replays answer with a redirect to the same file on lunarmelee.com, which reads it from storage and caches it worldwide, so follow redirects and accept gzip:

```bash
curl -L --compressed -OJ "https://api.lunarmelee.com/api/replays/6abd2df68fe2062a80e9c4a5/download"
```

```js
const res = await fetch("https://api.lunarmelee.com/api/replays/6abd2df68fe2062a80e9c4a5/download"); // follows the redirect, undoes gzip
const slp = new Uint8Array(await res.arrayBuffer());
```

```python
import requests
r = requests.get("https://api.lunarmelee.com/api/replays/6abd2df68fe2062a80e9c4a5/download")  # follows the redirect, undoes gzip
open("game.slp", "wb").write(r.content)
```

**More than a few dozen games:** use a [bulk download](#bulk-downloads). It's far faster for you and much lighter for us.

## Bulk downloads

Any search can become one zip file. The server collects the games, packs them and gives you a download link. Identical requests share one bundle, so popular downloads are often ready immediately.

**1. Estimate** how many games, how big, and how long the wait is:

```bash
curl -X POST "https://api.lunarmelee.com/api/replays/estimate" -H "Content-Type: application/json" \
  -d '{"p1CharacterId": "2", "source": "tournament", "maxFiles": 1000}'
```

**2. Create the job** with the same filter and your `X-Client-Id`:

```bash
curl -X POST "https://api.lunarmelee.com/api/jobs" -H "Content-Type: application/json" \
  -H "X-Client-Id: $LUNAR_CLIENT_ID" \
  -d '{"p1CharacterId": "2", "source": "tournament", "maxFiles": 1000}'
# → { "jobId": "…", "status": "pending", "reused": false, "lane": "fast" }
```

**3. Wait for it.** Poll `GET /api/jobs/{jobId}` every 10–30 seconds; it reports your place in line, progress and an estimated wait. When `downloadReady` is `true`, go on.

**4. Download.** `GET /api/jobs/{jobId}/download` gives a signed `url`, valid for an hour, that supports resuming (HTTP range requests):

```bash
curl -L -o fox-tournament.zip "$(curl -s "https://api.lunarmelee.com/api/jobs/$JOB/download" -H "X-Client-Id: $LUNAR_CLIENT_ID" | jq -r .url)"
```

**5. Unpack.** The zip holds `.slpz` files (Slippi replays, about 8× smaller) and `lunar-manifest.json`, which maps each file to its `replayId` and `fileHash`. Turn them back into `.slp` with [slpz](https://crates.io/crates/slpz) (`cargo install slpz`):

```bash
unzip fox-tournament.zip -d fox-tournament && slpz -d -r --rm fox-tournament
```

Good to know:
- You can have 3 jobs running at once. A finished bundle stays downloadable for 3 days after its last download.
- Up to 200 MB goes in a fast lane; bigger bundles take longer, roughly 10–20 GB an hour when the server is busy.
- To download specific games, send `replayIds` (up to 100,000) instead of filters. To download the games behind a clip search, send `clipSearch`.
- **The whole database** is one ready-made zip (~1.3 TB): find it in `GET /api/jobs/bundles` (`fullDb: true`) and fetch its link from `/api/jobs/{id}/download`. It's a snapshot, so newer games aren't in it; limited to 2 links per 24 hours.
- `GET /api/jobs/queue` shows the live queue, the same one as [lunarmelee.com/queue](https://lunarmelee.com/queue).

## Data notes

- **Ids.** Replays, jobs and clips have 24-character hex ids. Tournaments have slugs (`kotj-8`), sets have `sgg-…` (start.gg) or `dir-…` ids, and players are identified by their Slippi connect code (`MANG#0`; URL-encode the `#` as `%23`).
- **Players.** `players` lists every port in the game, in port order. `playerIndex` is the port (0–3). In searches, `p1` and `p2` mean "one player" and "the other player", whichever ports they used.
- **Sources.** `tournament` (recorded at events), `netplay` (online: tournaments, unranked and direct games) and `ranked` (Slippi ranked, anonymised: names are rank tiers and dates are missing).
- **Dates.** `startAt` is when the game started (UTC), or `null` when the console clock was unset or impossible.
- **Duplicates.** The same game recorded twice is shown once; the extra copies never appear in searches, counts or bundles.
- **Stats** come from Lunar's own extraction (the same detectors as [Lunar Clipper](https://lunarmelee.com/software)). A game not yet processed has `stats: null`.
- **Characters and stages** use Slippi's ids and names (`/api/reference/characters`, `/api/reference/stages`).
- **Privacy.** Only what a replay itself shows is public: connect codes and in-game names. Players' account links and old names are never served.

## Fair use

Lunar is a free, ad-free community project on a single server. To keep it that way for everyone:

- **Cache** what you fetch. Replays never change; stats and profiles change at most daily.
- **Use bulk downloads** for many games, and the full-database zip for everything, instead of looping over single downloads.
- **Keep it gentle:** a few requests at a time, and back off on `429` and `503`.
- **Say who you are** with a `User-Agent`, and credit "Data from Lunar Melee (lunarmelee.com)" where people will see it. It's appreciated, not required.
- Don't use the API to identify or track people beyond what their games show.

We may block traffic that degrades the service for others. Building something bigger, or need higher limits? Talk to us in [Discord](https://discord.gg/ThjMCW3F4R).

**Changes.** New fields and endpoints are added without notice, so ignore fields you don't know. Anything that would break existing clients is announced in Discord first, with the spec's `info.version` bumped.

## Endpoints

### Replays

Search games, read their details and stats, download them.

#### Search replays

```
GET /api/replays
```

Every game matching your filters, newest first. Filters combine: all must match. `p1` and `p2` are "one player" and "the other player", in any ports, so `p1CharacterId=2&p2CharacterId=20` finds Fox vs Falco whichever port each was on. List values are comma-separated (up to 20).

Rate limit: 30/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `p1ConnectCode` | query | string | Connect code(s) of one player, comma-separated. Example: `MANG#0`. |
| `p1CharacterId` | query | string | Character id(s) of that player, comma-separated. |
| `p1DisplayName` | query | string | Display name(s) of that player (prefix match, any case), comma-separated. |
| `p1Rank` | query | string | Ranked only: rank tier(s) of that player: `platinum`, `diamond`, `master`. |
| `p2ConnectCode` | query | string | Connect code(s) of the other player. |
| `p2CharacterId` | query | string | Character id(s) of the other player. |
| `p2DisplayName` | query | string | Display name(s) of the other player. |
| `p2Rank` | query | string | Ranked only: rank tier(s) of the other player. |
| `stageId` | query | string | Stage id(s), comma-separated. |
| `source` | query | string | `tournament`, `netplay`, `ranked`, comma-separated. Example: `tournament`. |
| `tournament` | query | string | Tournament key(s), comma-separated. Example: `kotj-8`. |
| `startDate` | query | string | Games on or after this date (`YYYY-MM-DD` or ISO 8601). Example: `2024-01-01`. |
| `endDate` | query | string | Games on or before this date. A date-only value includes that whole day (UTC). Example: `2024-12-31`. |
| `sort` | query | string | `startAt:-1` (newest first, default) or `startAt:1` (oldest first). Decides which games a limit keeps. |
| `page` | query | integer | Page (from 1). |
| `limit` | query | integer | Results per page (up to 1,000). |

**200** A page of games.

```json
{
  "replays": [
    {
      "_id": "6abd2df68fe2062a80e9c4a5",
      "fileHash": "da512d2cee450d44b34c649a9bcfd9cb",
      "fileSize": 3998829,
      "stageId": 31,
      "stageName": "Battlefield",
      "startAt": "2026-09-28T23:20:59.410Z",
      "startAtRaw": null,
      "duration": 10922,
      "players": [
        {
          "playerIndex": 0,
          "connectCode": "OSH#0",
          "displayName": "blue",
          "tag": null,
          "characterId": 20,
          "characterName": "Falco"
        },
        {
          "playerIndex": 1,
          "connectCode": "HUCK#242",
          "displayName": "HuckleberryFinn",
          "tag": null,
          "characterId": 2,
          "characterName": "Fox"
        }
      ],
      "winner": null,
      "matchId": "mode.direct-2026-09-28T23:19:12.32Z-0",
      "gameNumber": 2,
      "tiebreaker": 0,
      "mode": "direct",
      "tournamentKey": "kotj-8",
      "setId": "dir-f2308393e531e9a692e5",
      "setGame": 1,
      "duplicateOf": null,
      "charPair": "2-20",
      "source": "tournament",
      "usable": true,
      "viewCount": 12,
      "indexedAt": "2026-09-30T15:42:29.990Z",
      "tournamentName": "KOTJ #8",
      "stats": {
        "winner": 1,
        "winMethod": "stocks",
        "endMethod": 2,
        "lastFrame": 10922,
        "gameComplete": true,
        "players": [
          {
            "playerIndex": 0,
            "characterColor": 2,
            "startStocks": 4,
            "stocksLost": 4,
            "kills": 2,
            "openings": 17,
            "damageDealt": 300.49,
            "neutralWins": 11,
            "inputsPerMinute": 292.6
          },
          {
            "playerIndex": 1,
            "characterColor": 0,
            "startStocks": 4,
            "stocksLost": 2,
            "kills": 4,
            "openings": 21,
            "damageDealt": 242.22,
            "neutralWins": 13,
            "inputsPerMinute": 231.9
          }
        ]
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 1,
    "total": 11507,
    "pages": 11507,
    "totalCapped": false
  }
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

**500** Something went wrong on our side. Safe to retry after a short wait.

#### Get a replay

```
GET /api/replays/{id}
```

One game: players, stage, date, length and where it belongs (tournament, set).

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Replay id. |

**200** The game.

```json
{
  "_id": "6abd2df68fe2062a80e9c4a5",
  "fileHash": "da512d2cee450d44b34c649a9bcfd9cb",
  "fileSize": 3998829,
  "stageId": 31,
  "stageName": "Battlefield",
  "startAt": "2026-09-28T23:20:59.410Z",
  "startAtRaw": null,
  "duration": 10922,
  "players": [
    {
      "playerIndex": 0,
      "connectCode": "OSH#0",
      "displayName": "blue",
      "tag": null,
      "characterId": 20,
      "characterName": "Falco"
    },
    {
      "playerIndex": 1,
      "connectCode": "HUCK#242",
      "displayName": "HuckleberryFinn",
      "tag": null,
      "characterId": 2,
      "characterName": "Fox"
    }
  ],
  "winner": null,
  "matchId": "mode.direct-2026-09-28T23:19:12.32Z-0",
  "gameNumber": 2,
  "tiebreaker": 0,
  "mode": "direct",
  "tournamentKey": "kotj-8",
  "setId": "dir-f2308393e531e9a692e5",
  "setGame": 1,
  "duplicateOf": null,
  "charPair": "2-20",
  "source": "tournament",
  "usable": true,
  "viewCount": 12,
  "indexedAt": "2026-09-30T15:42:29.990Z",
  "tournamentName": "KOTJ #8"
}
```

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Get a replay's stats

```
GET /api/replays/{id}/stats
```

Everything Lunar extracted from one game: the summary (rules, result, per-player stats, positioning, tech and ledge choices) and its events (conversions, deaths, combos, edgeguards, quit-outs, tech and ledge options).

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Replay id. |

**200** Stats for the game.

**404** No such game, or not processed yet (`{ "error": "No stats for this replay yet" }`).

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Download a replay

```
GET /api/replays/{id}/download
```

The game's `.slp` file, ready for Slippi Dolphin. Most games answer `302` with the file's address on lunarmelee.com (storage-backed, cached worldwide): follow redirects. Sent gzip-compressed when you accept it.

Rate limit: 30/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Replay id. |

**200** The `.slp` file (`Content-Disposition` carries its name).

**302** Download it from `Location` (lunarmelee.com).

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

**503** Briefly unavailable (`storage_busy`, `download_cap`). Retry after `Retry-After` seconds.

#### Record a view (internal: lunarmelee.com only)

```
POST /api/replays/{id}/view
```

Counts one watch in the website's replay viewer (`viewCount`). For lunarmelee.com.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Replay id. |

**200** The new count.

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Where a replay is stored (internal: lunarmelee.com only)

```
GET /api/replays/{id}/source
```

For lunarmelee.com only (service key): the byte range of a replay inside the full-database zip on storage, or `{ "source": null }`.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Replay id. |

**200** Where to read it.

**403** Not the website.

**404** Nothing has this id.

### Clips

Combos, edgeguards and quit-outs, found in every processed game.

#### Search clips

```
POST /api/clips
```

Combos, edgeguards and quit-outs found in every processed game, with the frames they happen on: open the game at `startFrame` to watch it. Sorted newest first, or `best` for the most damage.

Rate limit: 30/minute.

Body (JSON, ClipSearch):

| Field | Type | Description |
|---|---|---|
| `type` | string | What kind of moment. |
| `attackerCharacterId` | string | Character id(s) of the player doing the combo/edgeguard (comma-separated or array). |
| `victimCharacterId` | string | Character id(s) of the player receiving it. |
| `attackerConnectCode` | string | Connect code(s) of the attacker. |
| `victimConnectCode` | string | Connect code(s) of the victim. |
| `stageId` | string | Stage id(s). |
| `source` | string | `tournament`, `netplay`, `ranked`. |
| `tournament` | string | Tournament key(s). |
| `startDate` | string | From this date (`YYYY-MM-DD`). |
| `endDate` | string | Through this date (`YYYY-MM-DD`). |
| `minDamage` | number | Combos only: at least this much damage (percent). |
| `minMoves` | integer | At least this many hits. |
| `killOnly` | boolean | Combos only: only combos that took a stock. |
| `zeroToDeath` | boolean | Combos only: only 0-to-deaths. |
| `includeInfinites` | boolean | Include wobbles and one-move infinites (hidden by default). |
| `withMoves` | boolean | Include each clip's full move list (`moveList`). Off by default to keep results small. |
| `sort` | string | `newest` (default), `oldest` or `best` (most damage). |
| `page` | integer | Page (1–400). |
| `limit` | integer | Results per page (1–100, default 25). |

**200** A page of clips.

```json
{
  "results": [
    {
      "id": "6abcbc7c7e65a2c0d7ff9b3d",
      "replayId": "69be7ae05febbbc18f5babb5",
      "type": "combo",
      "startFrame": 3986,
      "endFrame": 4091,
      "gameFrames": 4458,
      "stageId": 7,
      "source": "netplay",
      "startAt": "2023-11-13T02:27:39.000Z",
      "attacker": {
        "port": 0,
        "characterId": 2,
        "connectCode": "TTVT#312",
        "displayName": "TTVthenickbros"
      },
      "victim": {
        "port": 1,
        "characterId": 11,
        "connectCode": "NSTR#907",
        "displayName": "PracticalNess"
      },
      "startPercent": 67,
      "endPercent": 307,
      "damage": 240,
      "moves": 5,
      "didKill": true,
      "score": null,
      "rank": 240,
      "infinite": false,
      "metrics": null
    }
  ],
  "total": 10000,
  "capped": true,
  "page": 1,
  "limit": 1
}
```

**400** The request is invalid. `code` says why when the error has one.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

### Bulk downloads

Any search as one zip: estimate, create a job, wait, download. Also the whole database.

#### Estimate a bulk download

```
POST /api/replays/estimate
```

How many games a filter selects, how big the zip would be, and how long you would wait if you created the job now. Send exactly what you would send to create the job.

Rate limit: 15/minute.

Body (JSON, ReplayFilter):

| Field | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Connect code(s) of one player, comma-separated. |
| `p1CharacterId` | string | Character id(s) of that player, comma-separated. |
| `p1DisplayName` | string | Display name(s) of that player (prefix match, any case), comma-separated. |
| `p1Rank` | string | Ranked only: rank tier(s) of that player: `platinum`, `diamond`, `master`. |
| `p2ConnectCode` | string | Connect code(s) of the other player. |
| `p2CharacterId` | string | Character id(s) of the other player. |
| `p2DisplayName` | string | Display name(s) of the other player. |
| `p2Rank` | string | Ranked only: rank tier(s) of the other player. |
| `stageId` | string | Stage id(s), comma-separated. |
| `source` | string | `tournament`, `netplay`, `ranked`, comma-separated. |
| `tournament` | string | Tournament key(s), comma-separated. |
| `startDate` | string | Games on or after this date (`YYYY-MM-DD` or ISO 8601). |
| `endDate` | string | Games on or before this date. A date-only value includes that whole day (UTC). |
| `sort` | string | `startAt:-1` (newest first, default) or `startAt:1` (oldest first). Decides which games a limit keeps. |
| `maxFiles` | integer | Keep at most this many games (in `sort` order). |
| `maxSizeMb` | number | Keep games until the bundle reaches this many MB (max 10,000). |
| `replayIds` | string[] | Instead of filters: exactly these games (up to 100,000 ids). Ids that aren't found are skipped and counted in `missing`. |
| `clipSearch` | ClipSearch | Instead of filters: the games behind a clip search (its selecting fields; `page`, `limit`, `sort` are ignored). `maxFiles` still applies. |

**200** The estimate.

```json
{
  "replayCount": 1000,
  "capped": false,
  "rawSize": 3495824030,
  "estimatedSlpzSize": 436978003,
  "estimatedZipSize": 437106000,
  "estimatedTimeSec": 370,
  "totalDurationFrames": 6464820,
  "queue": {
    "reusable": null,
    "tooLarge": false,
    "maxBytes": 0,
    "lane": "bulk",
    "ahead": 0,
    "startSec": 0,
    "readySec": 390,
    "paused": null
  }
}
```

**400** The request is invalid. `code` says why when the error has one.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Create a bulk download

```
POST /api/jobs
```

Starts packing the selected games into one zip. If someone already asked for exactly this, you share their job (`reused: true`) or get their finished bundle at once. Then follow it with `GET /api/jobs/{id}`.

Rate limit: 5/hour. Needs `X-Client-Id`.

Body (JSON, ReplayFilter):

| Field | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Connect code(s) of one player, comma-separated. |
| `p1CharacterId` | string | Character id(s) of that player, comma-separated. |
| `p1DisplayName` | string | Display name(s) of that player (prefix match, any case), comma-separated. |
| `p1Rank` | string | Ranked only: rank tier(s) of that player: `platinum`, `diamond`, `master`. |
| `p2ConnectCode` | string | Connect code(s) of the other player. |
| `p2CharacterId` | string | Character id(s) of the other player. |
| `p2DisplayName` | string | Display name(s) of the other player. |
| `p2Rank` | string | Ranked only: rank tier(s) of the other player. |
| `stageId` | string | Stage id(s), comma-separated. |
| `source` | string | `tournament`, `netplay`, `ranked`, comma-separated. |
| `tournament` | string | Tournament key(s), comma-separated. |
| `startDate` | string | Games on or after this date (`YYYY-MM-DD` or ISO 8601). |
| `endDate` | string | Games on or before this date. A date-only value includes that whole day (UTC). |
| `sort` | string | `startAt:-1` (newest first, default) or `startAt:1` (oldest first). Decides which games a limit keeps. |
| `maxFiles` | integer | Keep at most this many games (in `sort` order). |
| `maxSizeMb` | number | Keep games until the bundle reaches this many MB (max 10,000). |
| `replayIds` | string[] | Instead of filters: exactly these games (up to 100,000 ids). Ids that aren't found are skipped and counted in `missing`. |
| `clipSearch` | ClipSearch | Instead of filters: the games behind a clip search (its selecting fields; `page`, `limit`, `sort` are ignored). `maxFiles` still applies. |

**200** Sharing an existing job for the same games.

```json
{
  "jobId": "6ac806db1ccf5f10dbda2c67",
  "status": "completed",
  "reused": true
}
```

**201** Created.

```json
{
  "jobId": "6ac806db1ccf5f10dbda2c67",
  "status": "pending",
  "reused": false,
  "lane": "bulk"
}
```

**400** The request is invalid. `code` says why when the error has one.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

**500** Something went wrong on our side. Safe to retry after a short wait.

#### Check a job

```
GET /api/jobs/{id}
```

Status, place in line, progress and the estimated wait. Poll every 10–30 seconds until `downloadReady`.

Rate limit: 60/minute. Needs `X-Client-Id`.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Job id. |

**200** The job.

```json
{
  "jobId": "6ac806db1ccf5f10dbda2c67",
  "status": "bundling",
  "replayCount": 1000,
  "totalMatched": 41210,
  "capped": true,
  "estimatedSize": 3495824030,
  "bundleSize": null,
  "downloadReady": false,
  "pinned": false,
  "downloadCount": 0,
  "progress": {
    "step": "bundling",
    "filesProcessed": 412,
    "filesTotal": 1000
  },
  "error": null,
  "queuePosition": 0,
  "estimatedWaitSec": 0,
  "estimatedProcessingTimeSec": 210,
  "lane": "bulk",
  "sharedWith": 0,
  "paused": null,
  "createdAt": "2026-10-08T21:02:11.000Z",
  "startedAt": "2026-10-08T21:02:15.000Z",
  "completedAt": null,
  "lastDownloadedAt": null,
  "expiresAt": null
}
```

**403** The job belongs to another client (`forbidden`).

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Get a bundle's download link

```
GET /api/jobs/{id}/download
```

A signed link to the finished zip, valid for an hour, with resumable (range) downloads. Any finished bundle can be downloaded by anyone who has its id. Full-database links are limited to 2 per 24 hours.

Rate limit: 20/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Job id. |
| `filename` | query | string | Name to save the file as (`.zip` is added). |

**200** The link.

**400** The request is invalid. `code` says why when the error has one.

**404** Nothing has this id.

**410** The bundle has expired (`bundle_missing`): create the job again.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

**503** Briefly unavailable (`storage_busy`, `download_cap`). Retry after `Retry-After` seconds.

#### Cancel a job

```
DELETE /api/jobs/{id}
```

Stops a job that hasn't finished. If others share it, you just leave it and it carries on for them.

Rate limit: 10/minute. Needs `X-Client-Id`.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Job id. |

**200** Cancelled.

**400** The request is invalid. `code` says why when the error has one.

**403** The job belongs to another client (`forbidden`).

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### List your jobs

```
GET /api/jobs
```

Your jobs (created or shared), newest first.

Rate limit: 30/minute. Needs `X-Client-Id`.

| Parameter | In | Type | Description |
|---|---|---|---|
| `page` | query | integer | Page. |
| `limit` | query | integer | Per page (up to 100). |

**200** Your jobs.

**400** The request is invalid. `code` says why when the error has one.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### See the download queue

```
GET /api/jobs/queue
```

What is being built, what is waiting (with forecasts) and recent bundles anyone can download now. Never says who asked for what; `mine` marks your own jobs when you send `X-Client-Id`.

Rate limit: 60/minute. Needs `X-Client-Id`.

**200** The queue.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### List permanent bundles

```
GET /api/jobs/bundles
```

Bundles kept for good, including the whole database (`fullDb: true`), most downloaded first.

Rate limit: 30/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `page` | query | integer | Page. |
| `limit` | query | integer | Per page (up to 50). |

**200** Permanent bundles.

```json
{
  "bundles": [
    {
      "_id": "a11db000a11db000a11db000",
      "bundleSize": 1295550885100,
      "completedAt": "2026-09-26T17:26:19.666Z",
      "downloadCount": 17,
      "filter": {},
      "lastDownloadedAt": "2026-09-29T16:42:06.912Z",
      "replayCount": 3169618,
      "snapshotAt": "2026-06-17T20:06:51.000Z",
      "fullDb": true
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

### Players

Find players and their career stats.

#### Autocomplete players

```
GET /api/players/autocomplete
```

Players whose connect code, display name or known alias starts with `q`, most active first. Made for search-as-you-type; with no `q`, the most active players. Queries of 4+ characters also match codes whose tag starts the query (`mango` finds `MANG#0`).

Rate limit: 30/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `q` | query | string | What has been typed. |
| `limit` | query | integer | Suggestions (up to 100). |

**200** Suggestions.

```json
[
  {
    "connectCode": "MANG#0",
    "displayName": "mang",
    "gameCount": 49911,
    "tag": null,
    "aliases": [
      "Mango"
    ]
  },
  {
    "connectCode": "MAN#758",
    "displayName": "chickenman400",
    "gameCount": 211,
    "tag": null,
    "aliases": []
  }
]
```

**400** The request is invalid. `code` says why when the error has one.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Search players

```
GET /api/players/search
```

Players whose connect code, display name or alias starts with `q` (2+ characters), most active first.

Rate limit: 30/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `q` | query | string | **Required.** Start of a code or name. |
| `limit` | query | integer | Results (up to 50). |

**200** Matching players.

**400** The request is invalid. `code` says why when the error has one.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Most active players

```
GET /api/players/top
```

Players with the most 1v1 games: record, main character and last game.

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `limit` | query | integer | Players (up to 100). |

**200** Players, most games first.

```json
[
  {
    "connectCode": "XX#02",
    "name": "Hax$",
    "games": 112157,
    "decided": 106124,
    "wins": 90601,
    "mainCharacterId": 2,
    "lastPlayed": "2025-03-06T16:51:41.000Z"
  }
]
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Get a player profile

```
GET /api/players/{code}/profile
```

Career stats for a connect code from its 1v1 games: record overall, per character, stage and opponent character, most played opponents, monthly activity, career totals and tech/ledge habits. URL-encode the `#` (`MANG%230`).

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `code` | path | string | Connect code, URL-encoded. |

**200** The profile.

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

### Tournaments

Tournaments, their brackets and sets.

#### List tournaments

```
GET /api/tournaments
```

Tournaments with games in the archive, most recent first (or most games). `q` matches every word of the name, ignoring punctuation (`kotj 7` finds "KOTJ #7").

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `q` | query | string | Words in the name. |
| `sort` | query | string | `recent` (by last game) or `games`. |
| `page` | query | integer | Page. |
| `limit` | query | integer | Per page (up to 100). |

**200** A page of tournaments.

```json
{
  "tournaments": [
    {
      "_id": "the-construct-224",
      "name": "The Construct 224",
      "startggSlug": "the-construct-224",
      "location": "Milwaukee, WI",
      "firstAt": "2026-09-27T19:22:39.110Z",
      "lastAt": "2026-09-27T21:15:08.500Z",
      "games": 47,
      "sets": 20,
      "characters": [
        {
          "characterId": 0,
          "games": 23
        },
        {
          "characterId": 20,
          "games": 17
        },
        {
          "characterId": 14,
          "games": 14
        }
      ]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 1,
    "total": 2445,
    "pages": 2445
  }
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Get a tournament

```
GET /api/tournaments/{key}
```

A tournament's summary (players, characters, stages) and all its sets with their games. `sets=0` leaves the sets out.

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `key` | path | string | Tournament key. |
| `sets` | query | string | `0` to leave out the sets. |

**200** The tournament.

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Get a set

```
GET /api/sets/{id}
```

One set: round, the two sides and score, and its games in order.

Rate limit: 60/minute.

| Parameter | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Set id. |

**200** The set.

```json
{
  "_id": "dir-221f1ffb1aa9aa0a448d",
  "source": "jungle",
  "tournament": {
    "key": "kotj-8",
    "name": "KOTJ #8",
    "listed": true
  },
  "event": "KOTJ #8",
  "round": "Losers Round 3",
  "bestOf": null,
  "location": null,
  "startgg": null,
  "players": [
    {
      "name": "b0xx bigot",
      "prefix": null,
      "port": null,
      "score": 3
    },
    {
      "name": "Smurf",
      "prefix": null,
      "port": null,
      "score": 1
    }
  ],
  "winner": 0,
  "games": [
    {
      "replayId": "6abd2df68fe2062a80e9c4cc",
      "n": 1,
      "winner": 0
    },
    {
      "replayId": "6abd2df68fe2062a80e9c4cd",
      "n": 2,
      "winner": 1
    }
  ],
  "startAt": null,
  "tournamentKey": "kotj-8"
}
```

**404** Nothing has this id.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

### Archive

Totals for the whole archive.

#### Archive totals

```
GET /api/stats
```

How many games the archive holds, their combined size and length, and bulk download jobs by status. Updated every minute.

Rate limit: 60/minute.

**200** Totals.

```json
{
  "replays": 3294295,
  "jobs": {
    "completed": 745,
    "cancelled": 102,
    "failed": 58
  },
  "dbSizeBytes": 36015749812,
  "totalFileSizeBytes": 11816659743618,
  "totalDurationFrames": 21146969918,
  "replaysWithDuration": 2440287
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

### Reference

Character and stage ids.

#### Characters

```
GET /api/reference/characters
```

Every character id with its name and costumes (Slippi's ids).

**200** Characters.

```json
[
  {
    "id": 2,
    "name": "Fox",
    "shortName": "Fox",
    "colors": [
      "Default",
      "Red",
      "Blue",
      "Green"
    ]
  },
  {
    "id": 20,
    "name": "Falco",
    "shortName": "Falco",
    "colors": [
      "Default",
      "Red",
      "Blue",
      "Green"
    ]
  }
]
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Stages

```
GET /api/reference/stages
```

Every stage id with its name (Slippi's ids). Tournament-legal: Fountain of Dreams 2, Pokémon Stadium 3, Yoshi's Story 8, Dream Land 28, Battlefield 31, Final Destination 32.

**200** Stages.

```json
[
  {
    "id": 31,
    "name": "Battlefield",
    "mode": "vs"
  },
  {
    "id": 32,
    "name": "Final Destination",
    "mode": "vs"
  }
]
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

### Status

Health checks and this spec.

#### Health

```
GET /health
```

Answers `{ "ok": true }` while the API is up.

**200** Up.

```json
{
  "ok": true
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### Health detail

```
GET /healthz
```

Up and whether the database and storage checks pass: `ok` or `degraded`.

**200** Status.

```json
{
  "status": "ok",
  "detail": "7 checks ok"
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### This spec

```
GET /openapi.json
```

The API described as OpenAPI 3.1.

**200** The spec.

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

#### About this API

```
GET /
```

Name, version and where the docs are.

**200** Pointers.

```json
{
  "name": "Lunar Melee API",
  "version": "1.0.0",
  "docs": "https://lunarmelee.com/developers",
  "openapi": "https://api.lunarmelee.com/openapi.json"
}
```

**429** Too many requests. Wait for `Retry-After` seconds (or the `RateLimit-Reset` header) and try again.

## Schemas

### Replay

One game.

| Field | Type | Description |
|---|---|---|
| `_id` | string | Replay id. |
| `fileHash` | string | MD5 of the original `.slp` file. |
| `fileSize` | integer \| null | Size of the `.slp` in bytes. |
| `stageId` | integer \| null | Stage id (see `/api/reference/stages`). |
| `stageName` | string \| null | Stage name. |
| `startAt` | string \| null | When the game started (UTC). `null` when unknown. |
| `startAtRaw` | string \| null | An impossible recorded date (bad console clock), kept for reference; `startAt` is then `null`. |
| `duration` | integer \| null | Length in frames (60 per second). |
| `players` | ReplayPlayer[] | Every port in the game, in port order. |
| `winner` | integer \| null | `playerIndex` of the winner, from the replay itself; `null` when inconclusive. |
| `matchId` | string \| null | Slippi match id shared by every game of an online set. |
| `gameNumber` | integer \| null | Game number within the online set. |
| `tiebreaker` | integer \| null | Tiebreaker number within the online set. |
| `mode` | string \| null | Slippi online mode: `ranked`, `unranked`, `direct`, `teams`… |
| `tournamentKey` | string \| null | The tournament this game belongs to (see `/api/tournaments/{key}`). |
| `tournamentName` | string \| null | Its name, when the tournament has a public page. |
| `setId` | string \| null | The set this game belongs to (see `/api/sets/{id}`). |
| `setGame` | integer \| null | Game number within the set. |
| `source` | string \| null | `tournament`, `netplay` or `ranked`. |
| `viewCount` | integer | Times watched on lunarmelee.com. |
| `indexedAt` | string | When Lunar added the game. |
| `charPair` | string \| null | The two characters of a 1v1 as a sorted pair (`2-20`), `multi` for 3–4 players. |
| `usable` | boolean \| null | Always `true` in responses (unusable games are hidden). |
| `duplicateOf` | string \| null | Always `null` in responses (duplicates are hidden). |
| `stats` | any |  |

### ReplayPlayer



| Field | Type | Description |
|---|---|---|
| `playerIndex` | integer | Port, 0–3. |
| `connectCode` | string \| null | Slippi connect code, e.g. `MANG#0`. `null` offline and in ranked. |
| `displayName` | string \| null | Slippi display name (in ranked: the rank tier). |
| `tag` | string \| null | In-game name tag, if one was set. |
| `characterId` | integer \| null | Character id (see `/api/reference/characters`). |
| `characterName` | string \| null | Character name. |

### ReplayRowStats

Compact extracted stats, or `null` for a game not yet processed. The full set is at `/api/replays/{id}/stats`.

| Field | Type | Description |
|---|---|---|
| `winner` | integer \| null | `playerIndex` of the winner, or `null` (no contest, LRAS, unknown). |
| `winMethod` | string \| null | How the game was decided: `stocks`, `timeout`, `lras`… |
| `endMethod` | integer \| null | Slippi game-end method code. |
| `lastFrame` | integer \| null | Last frame of the game. |
| `gameComplete` | boolean \| null | Whether the game was played to its end. |
| `players` | object[] | Headline numbers per player. |

### Pagination



| Field | Type | Description |
|---|---|---|
| `page` | integer | This page (from 1). |
| `limit` | integer | Results per page. |
| `total` | integer | Matches in total (see `totalCapped`). |
| `pages` | integer | Pages in total. |
| `totalCapped` | boolean | Replay search only: counting stopped at a cap, so there are at least `total` matches. |

### Error

An error. Some codes add fields (see the Errors guide).

| Field | Type | Description |
|---|---|---|
| `error` | string | What went wrong, in plain English. |
| `code` | string | Machine-readable reason, for the errors that have one. |

### ReplayFilter

Which games to bundle: the same filters as replay search (lists may also be comma-separated strings), and at least one filter or limit.

| Field | Type | Description |
|---|---|---|
| `p1ConnectCode` | string | Connect code(s) of one player, comma-separated. |
| `p1CharacterId` | string | Character id(s) of that player, comma-separated. |
| `p1DisplayName` | string | Display name(s) of that player (prefix match, any case), comma-separated. |
| `p1Rank` | string | Ranked only: rank tier(s) of that player: `platinum`, `diamond`, `master`. |
| `p2ConnectCode` | string | Connect code(s) of the other player. |
| `p2CharacterId` | string | Character id(s) of the other player. |
| `p2DisplayName` | string | Display name(s) of the other player. |
| `p2Rank` | string | Ranked only: rank tier(s) of the other player. |
| `stageId` | string | Stage id(s), comma-separated. |
| `source` | string | `tournament`, `netplay`, `ranked`, comma-separated. |
| `tournament` | string | Tournament key(s), comma-separated. |
| `startDate` | string | Games on or after this date (`YYYY-MM-DD` or ISO 8601). |
| `endDate` | string | Games on or before this date. A date-only value includes that whole day (UTC). |
| `sort` | string | `startAt:-1` (newest first, default) or `startAt:1` (oldest first). Decides which games a limit keeps. |
| `maxFiles` | integer | Keep at most this many games (in `sort` order). |
| `maxSizeMb` | number | Keep games until the bundle reaches this many MB (max 10,000). |
| `replayIds` | string[] | Instead of filters: exactly these games (up to 100,000 ids). Ids that aren't found are skipped and counted in `missing`. |
| `clipSearch` | ClipSearch | Instead of filters: the games behind a clip search (its selecting fields; `page`, `limit`, `sort` are ignored). `maxFiles` still applies. |

### Estimate



| Field | Type | Description |
|---|---|---|
| `replayCount` | integer | Games in the bundle. |
| `missing` | integer | With `replayIds`: ids not found (skipped). |
| `capped` | boolean | Counting stopped at a cap: the numbers are "at least". |
| `rawSize` | integer | Size of the games as `.slp`, in bytes. |
| `estimatedSlpzSize` | integer | Size as `.slpz`. |
| `estimatedZipSize` | integer | Size of the download, in bytes. |
| `estimatedTimeSec` | integer | Seconds to build once started. |
| `totalDurationFrames` | integer | Combined length of the games, in frames. |
| `queue` | QueueForecast |  |

### QueueForecast



| Field | Type | Description |
|---|---|---|
| `reusable` | object \| null | Someone already asked for exactly this: creating a job shares it. |
| `tooLarge` | boolean | Bigger than one bundle may be (`maxBytes`). |
| `maxBytes` | integer | Largest bundle allowed, in bytes (0 = no limit). |
| `lane` | string | `fast` (small bundles) or `bulk`. |
| `ahead` | integer | Jobs that would start before yours. |
| `startSec` | integer | Seconds until yours would start. |
| `readySec` | integer | Seconds until yours would be ready. |
| `paused` | string \| null | Why downloads are paused, when they are. |

### ClipSearch

A clip search. Lists may be arrays or comma-separated strings (up to 20 values).

| Field | Type | Description |
|---|---|---|
| `type` | string | What kind of moment. |
| `attackerCharacterId` | string | Character id(s) of the player doing the combo/edgeguard (comma-separated or array). |
| `victimCharacterId` | string | Character id(s) of the player receiving it. |
| `attackerConnectCode` | string | Connect code(s) of the attacker. |
| `victimConnectCode` | string | Connect code(s) of the victim. |
| `stageId` | string | Stage id(s). |
| `source` | string | `tournament`, `netplay`, `ranked`. |
| `tournament` | string | Tournament key(s). |
| `startDate` | string | From this date (`YYYY-MM-DD`). |
| `endDate` | string | Through this date (`YYYY-MM-DD`). |
| `minDamage` | number | Combos only: at least this much damage (percent). |
| `minMoves` | integer | At least this many hits. |
| `killOnly` | boolean | Combos only: only combos that took a stock. |
| `zeroToDeath` | boolean | Combos only: only 0-to-deaths. |
| `includeInfinites` | boolean | Include wobbles and one-move infinites (hidden by default). |
| `withMoves` | boolean | Include each clip's full move list (`moveList`). Off by default to keep results small. |
| `sort` | string | `newest` (default), `oldest` or `best` (most damage). |
| `page` | integer | Page (1–400). |
| `limit` | integer | Results per page (1–100, default 25). |

### Clip



| Field | Type | Description |
|---|---|---|
| `id` | string | Clip id. |
| `replayId` | string | The game it happened in. |
| `type` | string | `combo`, `edgeguard` or `quitout`. |
| `startFrame` | integer | First frame of the moment. |
| `endFrame` | integer | Last frame of the moment. |
| `gameFrames` | integer | Length of the whole game, in frames. |
| `stageId` | integer | Stage id. |
| `source` | string | Replay source. |
| `startAt` | string \| null | When the game started. |
| `attacker` | ClipPlayer |  |
| `victim` | ClipPlayer |  |
| `startPercent` | number \| null | Victim's percent at the start. |
| `endPercent` | number \| null | Victim's percent at the end. |
| `damage` | number \| null | Damage done. |
| `moves` | integer \| null | Hits in the combo. |
| `didKill` | boolean \| null | Whether it took a stock. |
| `score` | number \| null | Edgeguard score, when scored. |
| `rank` | number \| null | Sort key for `best`. |
| `infinite` | boolean | A wobble or one-move infinite. |
| `metrics` | object \| null | Extra measurements, by clip type. |
| `moveList` | object[] | With `withMoves: true`: every hit, in order. |

### ClipPlayer



| Field | Type | Description |
|---|---|---|
| `port` | integer | Port, 0–3. |
| `characterId` | integer | Character id. |
| `connectCode` | string \| null | Connect code. |
| `displayName` | string \| null | Display name. |

### Job



| Field | Type | Description |
|---|---|---|
| `jobId` | string | Job id. |
| `status` | string | Where the job is. |
| `replayCount` | integer | Games in the bundle. |
| `totalMatched` | integer \| null | Games the filter matched before the limit. |
| `capped` | boolean | A limit trimmed the bundle (`replayCount` < `totalMatched`). |
| `estimatedSize` | integer \| null | Estimated `.slp` bytes. |
| `bundleSize` | integer \| null | Size of the finished zip, in bytes. |
| `downloadReady` | boolean | The zip can be downloaded now. |
| `pinned` | boolean \| null | Kept permanently. |
| `downloadCount` | integer \| null | Times downloaded. |
| `progress` | any |  |
| `error` | string \| null | Why it failed. |
| `queuePosition` | integer \| null | Place in line (1 = next); 0 once running. |
| `estimatedWaitSec` | integer \| null | Seconds until it starts. |
| `estimatedProcessingTimeSec` | integer \| null | Seconds until it is ready once started (while running: until ready). |
| `lane` | string \| null | `fast` or `bulk`. |
| `sharedWith` | integer | Other people waiting on this same bundle. |
| `paused` | string \| null | Why downloads are paused, when they are. |
| `createdAt` | string | Created. |
| `startedAt` | string \| null | Started. |
| `completedAt` | string \| null | Finished. |
| `lastDownloadedAt` | string \| null | Last downloaded. |
| `expiresAt` | string \| null | When the bundle will be removed (3 days after its last download); `null` if pinned or not finished. |

### JobSummary



| Field | Type | Description |
|---|---|---|
| `_id` | string | Job id. |
| `status` | string | Status. |
| `filter` | object | The job's filter as sent (an id list shows as `replayIdCount`; a clip search as its object). |
| `replayCount` | integer | Games. |
| `bundleSize` | integer \| null | Zip size in bytes. |
| `progress` | any |  |
| `error` | string \| null | Why it failed. |
| `downloadReady` | boolean | Downloadable now. |
| `createdAt` | string | Created. |
| `completedAt` | string \| null | Finished. |
| `lastDownloadedAt` | string \| null | Last downloaded. |

### JobProgress

Progress while the job runs.

| Field | Type | Description |
|---|---|---|
| `step` | string | `queued`, `compressing`, `bundling`, `uploading`… |
| `filesProcessed` | integer | Games packed so far. |
| `filesTotal` | integer | Games to pack. |
| `bytesUploaded` | integer | Bytes uploaded so far. |
| `bytesTotal` | integer | Bytes to upload. |

### Queue



| Field | Type | Description |
|---|---|---|
| `paused` | string \| null | Why downloads are paused, when they are. |
| `throughputBps` | integer | Recent build speed, bytes per second. |
| `workSec` | integer | Seconds until everything queued now is ready. |
| `running` | object[] | Being built now. |
| `waiting` | object[] | Waiting, in order (first 300). |
| `waitingTotal` | integer | Jobs waiting in total. |
| `recent` | object[] | Finished bundles anyone can download right now. |

### Bundle



| Field | Type | Description |
|---|---|---|
| `_id` | string | Job id: download it with `/api/jobs/{id}/download`. |
| `filter` | object | The job's filter as sent (an id list shows as `replayIdCount`; a clip search as its object). |
| `replayCount` | integer | Games. |
| `bundleSize` | integer | Zip size in bytes. |
| `downloadCount` | integer | Times downloaded. |
| `completedAt` | string | Built. |
| `lastDownloadedAt` | string \| null | Last downloaded. |
| `fullDb` | boolean | The whole-database zip. |
| `snapshotAt` | string \| null | Full database: when the snapshot was taken. |

### PlayerSuggestion



| Field | Type | Description |
|---|---|---|
| `connectCode` | string | Connect code. |
| `displayName` | string \| null | Most used display name. |
| `tag` | string \| null | In-game tag. |
| `aliases` | string[] | Other names this player is known by in the archive. |
| `gameCount` | integer | Games in the archive. |

### TopPlayer



| Field | Type | Description |
|---|---|---|
| `connectCode` | string | Connect code. |
| `name` | string \| null | Most used display name. |
| `games` | integer | 1v1 games. |
| `decided` | integer | Games with a winner. |
| `wins` | integer | Games won. |
| `mainCharacterId` | integer \| null | Most played character. |
| `lastPlayed` | string \| null | Last game. |

### PlayerProfile

Career stats from 1v1 games.

| Field | Type | Description |
|---|---|---|
| `connectCode` | string | Connect code. |
| `names` | object[] | The primary display name. |
| `games` | integer | Games. |
| `decided` | integer | Games with a winner. |
| `wins` | integer | Wins. |
| `firstPlayed` | string \| null | First game. |
| `lastPlayed` | string \| null | Last game. |
| `sources` | object | Games per source. |
| `characters` | object[] | Record per character played, most played first. |
| `stages` | object[] | Record per stage. |
| `vsCharacters` | object[] | Record against each character. |
| `opponents` | object[] | Most played opponents. |
| `monthly` | object[] | Activity per month. |
| `totals` | object | Career totals: kills, stocksLost, openings, damageDealt, neutralWins, counterHits, l-cancels, wavedashes, dash dances, ledge grabs, positioning frames… |
| `techLedge` | object | How often each tech and ledge option was chosen (`tech.in_place`, `ledge.drop`…). |
| `builtAt` | string | When the profile was last rebuilt. |

### TournamentSummary



| Field | Type | Description |
|---|---|---|
| `_id` | string | Tournament key. |
| `name` | string | Name. |
| `startggSlug` | string \| null | start.gg slug, when linked. |
| `location` | string \| null | Where it was held. |
| `firstAt` | string \| null | First game. |
| `lastAt` | string \| null | Last game. |
| `games` | integer | Games. |
| `sets` | integer | Sets. |
| `characters` | object[] | Most played characters (top 3 in lists). |

### Tournament



| Field | Type | Description |
|---|---|---|
| `_id` | string | Tournament key. |
| `name` | string | Name. |
| `startggSlug` | string \| null | start.gg slug, when linked. |
| `location` | string \| null | Where it was held. |
| `firstAt` | string \| null | First game. |
| `lastAt` | string \| null | Last game. |
| `games` | integer | Games. |
| `sets` | integer | Sets. |
| `characters` | object[] | Most played characters (top 3 in lists). |
| `listed` | boolean | Has a public page. |
| `players` | object[] | Players, most games first. |
| `stages` | object[] | Stages played. |

### Set



| Field | Type | Description |
|---|---|---|
| `_id` | string | Set id: `sgg-…` (start.gg) or `dir-…`. |
| `source` | string | Where the set came from. |
| `tournamentKey` | string | Tournament key. |
| `tournament` | object |  |
| `event` | string \| null | Event name. |
| `round` | string \| null | Bracket round, e.g. "Losers Round 3". |
| `bestOf` | integer \| null | Best of. |
| `location` | string \| null | Where it was played. |
| `startgg` | object \| null | start.gg ids (set, event, entrants, placements), when linked. |
| `players` | object[] | The two sides. |
| `winner` | integer \| null | Index into `players` of the winner. |
| `games` | object[] | Games in order. |
| `startAt` | string \| null | When the set started. |

### ArchiveStats



| Field | Type | Description |
|---|---|---|
| `replays` | integer | Searchable games. |
| `jobs` | object | Bulk download jobs by status. |
| `dbSizeBytes` | integer | Size of the index. |
| `totalFileSizeBytes` | integer | Size of every replay as `.slp`. |
| `totalDurationFrames` | integer | Combined length of every game, in frames. |
| `replaysWithDuration` | integer | Games with a known length. |

### Character



| Field | Type | Description |
|---|---|---|
| `id` | integer | Character id. |
| `name` | string | Name. |
| `shortName` | string | Short name. |
| `colors` | string[] | Costumes, by `characterColor` index. |

### Stage



| Field | Type | Description |
|---|---|---|
| `id` | integer | Stage id. |
| `name` | string | Name. |
| `mode` | string | Game mode it belongs to. |

## Not covered here

- Administration routes (`/api/admin/*`): see `ADMIN_API.md`.
- Replay submissions (`/api/submissions/*`): admin only, currently disabled.
- The website's service key (`X-Lunar-Service-Key`, `X-Visitor-Ip`): `src/middleware/serviceCaller.ts`. With it, `X-Client-Id` is the website visitor's id; without it, a caller's id is mapped into its own namespace (`publicClientId`).
