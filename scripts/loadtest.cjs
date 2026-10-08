// Load test the database API as the website would call it, on behalf of many
// visitors (the website's service key + a fake visitor IP per request, so
// per-visitor rate limits apply as in production). Random mix of searches (80%)
// and size estimates (20%) over characters, codes, stages, sources, tournaments.
//
// Run on the worker (reads PORT and LUNAR_SERVICE_KEY from ~/Projects/database/.env,
// prints no secrets):
//   scp scripts/loadtest.cjs matt@192.168.1.132:/tmp/ && ssh matt@192.168.1.132 node /tmp/loadtest.cjs
//   ... node /tmp/loadtest.cjs slow     # the 14 slowest requests at 10 concurrent
//   ... node /tmp/loadtest.cjs errors   # which requests fail, with the API's message
//   ... node /tmp/loadtest.cjs probe 'query' ...   # time single searches with no other load
// Steps 5/20/50/100 concurrent for 20 s each; stops when p95 passes 8 s.
const fs = require("fs");
const env = Object.fromEntries(fs.readFileSync(process.env.HOME + "/Projects/database/.env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const BASE = `http://127.0.0.1:${env.PORT || 3002}`;
const KEY = env.LUNAR_SERVICE_KEY;
const chars = [2, 20, 9, 12, 15, 13, 22, 25, 0, 1, 7, 14, 17, 19, 3, 4, 5, 6, 8, 10, 16, 18, 21, 23, 24];
const stages = [31, 32, 3, 8, 28, 2];
const codes = ["MANG#0", "ZAIN#0", "KING#870", "HBOX#305", "AKLO#0", "SAMI#0", "JMOOK#0", "CODY#0"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function params() {
  const p = new URLSearchParams();
  const r = Math.random();
  if (r < 0.35) p.set("p1CharacterId", String(pick(chars)));
  if (r < 0.2) p.set("p2CharacterId", String(pick(chars)));
  if (Math.random() < 0.3) p.set("p1ConnectCode", pick(codes));
  if (Math.random() < 0.25) p.set("stageId", String(pick(stages)));
  if (Math.random() < 0.15) p.set("source", pick(["netplay", "tournament", "ranked"]));
  if (Math.random() < 0.1) p.set("tournament", pick(["kotj-7", "midlane-melee-183", "waddle-wednesday-164"]));
  if (Math.random() < 0.2) p.set("sort", "startAt:1");
  return p;
}
async function one() {
  const ip = `10.${Math.floor(Math.random() * 4)}.${Math.floor(Math.random() * 250)}.1`;
  const headers = { "X-Lunar-Service-Key": KEY, "X-Visitor-Ip": ip, "X-Client-Id": require("crypto").randomUUID() };
  const p = params();
  const est = Math.random() < 0.2;
  const t = Date.now();
  let res;
  if (est) {
    const body = Object.fromEntries(p.entries());
    // An estimate needs a real filter (sort alone is rejected: filter_required).
    if (!Object.keys(body).some((k) => k !== "sort")) body.p1CharacterId = String(pick(chars));
    res = await fetch(`${BASE}/api/replays/estimate`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } else {
    p.set("page", String(1 + Math.floor(Math.random() * 5)));
    p.set("limit", String(pick([10, 25])));
    res = await fetch(`${BASE}/api/replays?${p}`, { headers });
  }
  const text = await res.text();
  return { ms: Date.now() - t, status: res.status, est, q: est ? 'EST ' + p.toString() : p.toString(), err: res.status === 200 ? undefined : text.slice(0, 200) };
}
async function step(conc, seconds) {
  const out = [];
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      try { out.push(await one()); } catch (e) { out.push({ ms: 0, status: "ERR", est: false }); }
    }
  }));
  const q = (a, p) => (a.length ? a.sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] : 0);
  const ok = out.filter((r) => r.status === 200);
  const search = ok.filter((r) => !r.est).map((r) => r.ms), estm = ok.filter((r) => r.est).map((r) => r.ms);
  const bad = {};
  for (const r of out) if (r.status !== 200) bad[r.status] = (bad[r.status] ?? 0) + 1;
  if (!ok.length) { console.log(`concurrency ${conc}: no successful requests`, JSON.stringify(bad)); return 99999; }
  console.log(`concurrency ${String(conc).padStart(3)}: ${(out.length / seconds).toFixed(1).padStart(5)} req/s | search p50 ${q(search, .5)} ms, p95 ${q(search, .95)} ms | estimate p50 ${q(estm, .5)} ms, p95 ${q(estm, .95)} ms | non-200: ${JSON.stringify(bad)}`);
  return q(search, .95);
}
(async () => {
  if (process.argv[2] === "probe") {
    // One request at a time, no other load: how long a given search really takes.
    // node loadtest.cjs probe 'p1CharacterId=16&p2CharacterId=12&tournament=kotj-7' ...
    for (const q of process.argv.slice(3)) {
      for (const run of ["first", "again"]) {
        const ip = "10.9.9.1";
        const headers = { "X-Lunar-Service-Key": KEY, "X-Visitor-Ip": ip, "X-Client-Id": require("crypto").randomUUID() };
        const t = Date.now();
        const res = await fetch(`${BASE}/api/replays?${q}&page=1&limit=25`, { headers });
        const j = await res.json().catch(() => ({}));
        console.log(`  ${String(Date.now() - t).padStart(6)} ms  ${res.status}  total=${j.total ?? "?"}  (${run})  ${q}`);
      }
    }
    return;
  }
  if (process.argv[2] === "errors") {
    // The requests that didn't return 200, with the API's message (for 4xx/5xx triage).
    const out = [];
    const end = Date.now() + 20000;
    await Promise.all(Array.from({ length: 5 }, async () => { while (Date.now() < end) out.push(await one()); }));
    const bad = out.filter((r) => r.status !== 200);
    console.log(`${out.length} requests, ${bad.length} not 200:`);
    for (const r of bad.slice(0, 15)) console.log(`  ${r.status}  ${r.q.replace(/&?(page|limit)=\d+/g, "")}  ->  ${r.err}`);
    return;
  }
  if (process.argv[2] === "slow") {
    const out = [];
    const end = Date.now() + 25000;
    await Promise.all(Array.from({ length: 10 }, async () => { while (Date.now() < end) out.push(await one()); }));
    out.sort((a, b) => b.ms - a.ms);
    console.log(`${out.length} requests; slowest:`);
    for (const r of out.slice(0, 14)) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.status}  ${r.q.replace(/&?(page|limit)=\d+/g, "")}`);
    return;
  }
  for (const c of [5, 20, 50, 100]) {
    const p95 = await step(c, 20);
    if (p95 > 8000) { console.log("stopping: p95 over 8 s"); break; }
  }
})();
