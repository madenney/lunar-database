import { parentPort } from "worker_threads";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseSlpFile } from "./slpParser";

parentPort!.on("message", (msg: { relPaths: string[]; rootDir: string }) => {
  const results: any[] = [];
  for (const relPath of msg.relPaths) {
    const absPath = path.join(msg.rootDir, relPath);
    try {
      const parsed = parseSlpFile(absPath);
      const stat = fs.statSync(absPath);
      const fileHash = crypto
        .createHash("md5")
        .update(`${stat.size}-${stat.mtimeMs}`)
        .digest("hex");

      const dir = path.dirname(relPath);
      results.push({
        filePath: relPath,
        fileHash,
        fileSize: stat.size,
        folderLabel: dir && dir !== "." ? dir : null,
        ...parsed,
        indexedAt: new Date(),
      });
    } catch (err) {
      // skip failed files
    }
  }
  parentPort!.postMessage(results);
});
