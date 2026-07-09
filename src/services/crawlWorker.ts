import { parentPort } from "worker_threads";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseSlpFile } from "./slpParser";
import { sourceFromFolderLabel } from "../models/Replay";

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
      const folderLabel = dir && dir !== "." ? dir : null;
      results.push({
        filePath: relPath,
        fileHash,
        fileSize: stat.size,
        folderLabel,
        // Tag the source from the import folder root so new crawls never need a backfill.
        source: sourceFromFolderLabel(folderLabel),
        ...parsed,
        indexedAt: new Date(),
      });
    } catch (err) {
      // skip failed files
    }
  }
  parentPort!.postMessage(results);
});
