# Database guidance

Read the root AGENTS.md and docs/architecture.md, then README.md, API.md and
ADMIN_API.md for this app's API and deployment.

Express/TypeScript service with MongoDB, replay indexing, job workers, bundle
building and signed storage downloads. Source lives here; the large replay
corpus and database/storage state remain external. Respect owner identity,
rate limits, download caps and worker ownership in API changes.

Use this app's compiler: node node_modules/typescript/bin/tsc --noEmit.
Tests include actual MongoDB writes and some hardcoded test database names.
Inspect them and use isolated test state before running; do not run the whole
suite as an innocent path check. Tests connect to `TEST_MONGODB_URL` (default
`mongodb://localhost:27017`, the live server): point it at a throwaway mongod,
e.g. `mongod --dbpath <tmp> --port 27099 --fork --logpath <tmp>/log`. `.env` holds
real storage and mail credentials, and dotenv won't override variables already
set, so also pass empty `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, a dead
`S3_ENDPOINT` and empty mail settings.

`npm run dev` has a predev hook that stops lm-database-api and kills port 3002.
Starting src/index.ts also starts workers. Do not start, stop, deploy, crawl,
compress, clean queues or install services without task authorization.
Local credentials, logs and private infrastructure runbooks stay out of Git.
