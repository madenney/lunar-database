/**
 * Fix replays with incorrect startAt dates caused by misconfigured Wii clocks.
 *
 * Extracts the real date from the folder path (tournament name or directory
 * structure) and corrects startAt, preserving the original time-of-day.
 *
 * Usage:
 *   npx ts-node src/scripts/fixDates.ts              # dry run
 *   npx ts-node src/scripts/fixDates.ts --apply       # actually write
 */

import { connectDb } from "../db";
import { Replay } from "../models/Replay";

const DRY_RUN = !process.argv.includes("--apply");

// Date extraction patterns (ordered by specificity)
const DATE_PATTERNS: { regex: RegExp; extract: (m: RegExpMatchArray) => Date | null }[] = [
  // YYYY-MM-DD or YYYY-M-D (Wichita, Morsecode netplay)
  {
    regex: /(\d{4})-(\d{1,2})-(\d{1,2})/,
    extract: (m) => parseDate(+m[1], +m[2], +m[3]),
  },
  // [M-D-YY] (Purdue Weeklies)
  {
    regex: /\[(\d{1,2})-(\d{1,2})-(\d{2})\]/,
    extract: (m) => {
      const yy = +m[3];
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      return parseDate(year, +m[1], +m[2]);
    },
  },
  // M-D-YYYY (CR Clash, Smashfest, Saint Rose, Clip It, etc.)
  {
    regex: /(\d{1,2})-(\d{1,2})-(\d{4})/,
    extract: (m) => parseDate(+m[3], +m[1], +m[2]),
  },
];

// Manual lookup for tournaments where dates were researched from start.gg/Liquipedia
// Key: substring to match in filePath → [year, month, day]
const MANUAL_DATES: Record<string, [number, number, number]> = {
  "Battle of BC 6":              [2024, 3, 29],
  "Battle of BC 4":              [2022, 6, 10],
  "GOML X":                      [2024, 6, 7],
  "Tipped Off 16":               [2025, 6, 7],
  "National Melee Arcadian 2":   [2019, 5, 5],
  "SoCal Arcadian":              [2019, 7, 28],
  "Kill Roy Vol 6":              [2023, 3, 4],
  "Kill Roy Vol 7":              [2023, 10, 7],
  "Kill Roy Vol 8":              [2024, 11, 2],
  "Summit 12":                   [2021, 12, 9],
  "Novembair":                   [2021, 11, 6],
  "Genesis X-2":                 [2024, 2, 16],
  "Genesis X":                   [2024, 2, 16],
  "Galint Smash Local 422":      [2022, 4, 22],
  "Galint Smash Local 3":        [2022, 4, 22], // same venue/series, approximate
};

// Tournament names with only a year — we'll use July 1 as a midpoint placeholder
const YEAR_ONLY: { regex: RegExp; yearGroup: number }[] = [
  { regex: /DPG (\d{4})/, yearGroup: 1 },
  { regex: /Shine (\d{4})/, yearGroup: 1 },
  { regex: /Collision (\d{4})/, yearGroup: 1 },
  { regex: /Riptide (\d{4})/, yearGroup: 1 },
];

function parseDate(year: number, month: number, day: number): Date | null {
  if (year < 2001 || year > 2026) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (isNaN(d.getTime())) return null;
  return d;
}

function extractDateFromPath(filePath: string): Date | null {
  // Try manual lookup first (most reliable)
  for (const [key, [year, month, day]] of Object.entries(MANUAL_DATES)) {
    if (filePath.includes(key)) {
      return parseDate(year, month, day);
    }
  }

  // Try regex date patterns
  for (const { regex, extract } of DATE_PATTERNS) {
    const m = filePath.match(regex);
    if (m) {
      const d = extract(m);
      if (d) return d;
    }
  }
  return null;
}

function extractYearFromPath(filePath: string): number | null {
  // Try tournament-year patterns
  for (const { regex, yearGroup } of YEAR_ONLY) {
    if (yearGroup === 0) continue; // skip patterns without year
    const m = filePath.match(regex);
    if (m) {
      const year = +m[yearGroup];
      if (year >= 2018 && year <= 2026) return year;
    }
  }
  return null;
}

/** Combine a new date (year/month/day) with the original time-of-day. */
function fixStartAt(original: Date, correctDate: Date): Date {
  const fixed = new Date(original);
  fixed.setUTCFullYear(correctDate.getUTCFullYear());
  fixed.setUTCMonth(correctDate.getUTCMonth());
  fixed.setUTCDate(correctDate.getUTCDate());
  return fixed;
}

function fixStartAtYear(original: Date, year: number): Date {
  const fixed = new Date(original);
  // Keep month/day from original (they may still be wrong, but at least the year is right)
  fixed.setUTCFullYear(year);
  return fixed;
}

async function main() {
  await connectDb();

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "APPLYING CHANGES"}\n`);

  // Find all replays with bad dates
  const badReplays = await Replay.find({
    $or: [
      { startAt: { $lt: new Date("2018-01-01"), $ne: null } },
      { startAt: { $gt: new Date("2026-06-01") } },
    ],
  })
    .select("filePath startAt")
    .lean();

  console.log(`Found ${badReplays.length} replays with bad dates\n`);

  let fixedByDate = 0;
  let fixedByYear = 0;
  let unfixable = 0;
  const unfixablePaths = new Set<string>();

  const bulkOps: any[] = [];

  for (const replay of badReplays) {
    if (!replay.startAt) { unfixable++; continue; }

    const exactDate = extractDateFromPath(replay.filePath);

    if (exactDate) {
      const corrected = fixStartAt(replay.startAt, exactDate);
      bulkOps.push({
        updateOne: {
          filter: { _id: replay._id },
          update: { $set: { startAt: corrected } },
        },
      });
      fixedByDate++;
      continue;
    }

    const year = extractYearFromPath(replay.filePath);
    if (year) {
      const corrected = fixStartAtYear(replay.startAt, year);
      bulkOps.push({
        updateOne: {
          filter: { _id: replay._id },
          update: { $set: { startAt: corrected } },
        },
      });
      fixedByYear++;
      continue;
    }

    unfixable++;
    // Extract folder for reporting
    const lastSlash = replay.filePath.lastIndexOf("/");
    const folder = lastSlash > 0 ? replay.filePath.substring(0, lastSlash) : replay.filePath;
    unfixablePaths.add(folder);
  }

  console.log(`Fixed by exact date from path:  ${fixedByDate}`);
  console.log(`Fixed by year from path:         ${fixedByYear}`);
  console.log(`Unfixable (no date in path):     ${unfixable}`);
  console.log(`Total fixable:                   ${fixedByDate + fixedByYear} / ${badReplays.length}\n`);

  if (unfixablePaths.size > 0) {
    console.log("Unfixable folders:");
    for (const p of [...unfixablePaths].sort()) {
      console.log(`  ${p}`);
    }
    console.log();
  }

  if (!DRY_RUN && bulkOps.length > 0) {
    console.log(`Writing ${bulkOps.length} updates...`);
    const result = await Replay.bulkWrite(bulkOps);
    console.log(`Done. Modified: ${result.modifiedCount}`);
  } else if (DRY_RUN && bulkOps.length > 0) {
    // Show some samples
    console.log("Sample fixes (first 10):");
    for (const op of bulkOps.slice(0, 10)) {
      const replay = badReplays.find((r) => r._id.equals(op.updateOne.filter._id));
      if (replay) {
        const newDate = op.updateOne.update.$set.startAt;
        console.log(`  ${replay.filePath}`);
        console.log(`    ${replay.startAt!.toISOString()} → ${newDate.toISOString()}`);
      }
    }
    console.log(`\nRun with --apply to write changes.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
