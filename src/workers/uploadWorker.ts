import path from "path";
import fs from "fs";
import crypto from "crypto";
import unzipper from "unzipper";
import { Upload } from "../models/Upload";
import { Submission } from "../models/Submission";
import { parseSlpFile } from "../services/slpParser";
import { config } from "../config";

async function createSubmissionFromSlp(
  slpPath: string,
  originalFilename: string,
  submittedBy: string | null,
  uploadId: string
): Promise<void> {
  let parsed;
  try {
    parsed = parseSlpFile(slpPath);
  } catch {
    parsed = { stageId: null, stageName: null, startAt: null, duration: null, players: [], winner: null };
  }

  await Submission.create({
    uploadId,
    originalFilename,
    airlockPath: slpPath,
    submittedBy,
    ...parsed,
  });
}

async function extractZip(upload: InstanceType<typeof Upload>): Promise<number> {
  let count = 0;
  let errors = 0;
  const dir = config.airlockDir;

  const directory = await unzipper.Open.file(upload.diskPath);
  for (const entry of directory.files) {
    if (entry.type !== "File" || !entry.path.endsWith(".slp")) continue;

    const unique = crypto.randomBytes(8).toString("hex");
    const basename = path.basename(entry.path);
    const destPath = path.join(dir, `${unique}-${basename}`);

    try {
      await new Promise<void>((resolve, reject) => {
        entry.stream()
          .pipe(fs.createWriteStream(destPath))
          .on("finish", resolve)
          .on("error", reject);
      });

      await createSubmissionFromSlp(destPath, basename, upload.submittedBy, upload._id.toString());
      count++;
    } catch (err) {
      errors++;
      console.error(`Upload ${upload._id}: failed on ${basename}:`, (err as Error).message);
      // Clean up the extracted file if it exists
      try { fs.unlinkSync(destPath); } catch {}
    }

    if (count % 100 === 0 && count > 0) {
      console.log(`Upload ${upload._id}: extracted ${count} files (${errors} errors)...`);
    }
  }

  // Remove the zip after extraction
  try { fs.unlinkSync(upload.diskPath); } catch {}

  if (errors > 0) {
    console.warn(`Upload ${upload._id}: completed with ${errors} errors out of ${count + errors} .slp files`);
  }

  return count;
}

export async function processUpload(uploadId: string): Promise<void> {
  const upload = await Upload.findById(uploadId);
  if (!upload) throw new Error(`Upload ${uploadId} not found`);

  try {
    const ext = path.extname(upload.originalFilename).toLowerCase();

    if (ext === ".slp") {
      await createSubmissionFromSlp(
        upload.diskPath,
        upload.originalFilename,
        upload.submittedBy,
        upload._id.toString()
      );
      upload.slpCount = 1;
    } else if (ext === ".zip") {
      upload.slpCount = await extractZip(upload);
    }

    upload.status = "done";
    await upload.save();
    console.log(`Upload ${upload._id} done: ${upload.slpCount} .slp files`);
  } catch (err) {
    upload.status = "failed";
    upload.error = (err as Error).message;
    await upload.save();
    console.error(`Upload ${upload._id} failed:`, (err as Error).message);
  }
}
