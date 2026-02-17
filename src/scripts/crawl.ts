import { connectDb } from "../db";
import { crawl } from "../services/crawler";

async function main() {
  const args = process.argv.slice(2);
  const skipDupeCheck = args.includes("--no-dupe-check");
  const dir = args.find((a) => !a.startsWith("--"));

  await connectDb();
  await crawl(dir, { skipDupeCheck });
  process.exit(0);
}

main().catch((err) => {
  console.error("Crawl failed:", err);
  process.exit(1);
});
