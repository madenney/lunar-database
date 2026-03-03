import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { config } from "../config";
import { Submission } from "../models/Submission";
import { Upload } from "../models/Upload";
import { Replay } from "../models/Replay";
import { parseSlpFile } from "../services/slpParser";
import { processUpload } from "../workers/submissionWorker";
import { requireAdmin } from "../middleware/auth";
import { sendError } from "../utils/sendError";

const router = Router();

// POST /api/submissions/upload — stream a .slp or .zip file to disk, then process
router.post("/upload", (req: Request, res: Response, next) => {
  res.status(503).json({ error: "Uploads are temporarily disabled" });
}, requireAdmin, async (req: Request, res: Response) => {
  try {
    const filename = req.headers["x-filename"] as string;
    if (!filename) {
      res.status(400).json({ error: "x-filename header is required" });
      return;
    }

    // Sanitize filename — strip path components to prevent directory traversal
    const sanitized = path.basename(filename);
    const ext = path.extname(sanitized).toLowerCase();
    if (ext !== ".slp" && ext !== ".zip") {
      res.status(400).json({ error: "Only .slp and .zip files are allowed" });
      return;
    }

    const submittedBy = (req.headers["x-submitted-by"] as string) || null;

    fs.mkdirSync(config.airlockDir, { recursive: true });
    const unique = crypto.randomBytes(8).toString("hex");
    const diskPath = path.join(config.airlockDir, `${unique}-${sanitized}`);

    // Create upload record
    const upload = await Upload.create({
      originalFilename: sanitized,
      diskPath,
      submittedBy,
      status: "uploading",
    });

    // Stream request body directly to disk
    const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB
    const writeStream = fs.createWriteStream(diskPath);
    let bytes = 0;
    let responded = false;

    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        writeStream.destroy();
        req.destroy();
        if (!responded) {
          responded = true;
          res.status(413).json({ error: "File too large (max 500MB)" });
        }
      }
    });

    req.pipe(writeStream);

    writeStream.on("finish", async () => {
      if (responded) return;
      responded = true;
      try {
        upload.fileSize = bytes;
        upload.status = "extracting";
        await upload.save();

        res.status(202).json({
          uploadId: upload._id,
          filename: sanitized,
          size: bytes,
          status: "extracting",
        });

        // Process in background (don't await — response already sent)
        processUpload(upload._id.toString()).catch((err) => {
          console.error(`Upload ${upload._id} processing failed:`, err.message);
        });
      } catch (err) {
        if (!responded) {
          res.status(500).json({ error: (err as Error).message });
        }
      }
    });

    writeStream.on("error", async (err) => {
      if (responded) return;
      responded = true;
      upload.status = "failed";
      upload.error = err.message;
      await upload.save().catch(() => {});
      res.status(500).json({ error: "Failed to write file" });
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/submissions/uploads — list uploads
router.get("/uploads", requireAdmin, async (req: Request, res: Response) => {
  try {
    const uploads = await Upload.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(uploads);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/submissions/uploads/:id — check upload status
router.get("/uploads/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const upload = await Upload.findById(req.params.id).lean();
    if (!upload) {
      res.status(404).json({ error: "Upload not found" });
      return;
    }
    res.json(upload);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/submissions — list submissions (filterable by status, uploadId)
router.get("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status = "pending", uploadId, page = "1", limit = "50" } = req.query;
    const query: Record<string, any> = {};
    if (status !== "all") query.status = String(status);
    if (uploadId) query.uploadId = String(uploadId);

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string, 10)));
    const skip = Math.min((pageNum - 1) * limitNum, 10000);

    const [submissions, total] = await Promise.all([
      Submission.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Submission.countDocuments(query),
    ]);

    res.json({
      submissions,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/submissions/:id
router.get("/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const submission = await Submission.findById(req.params.id).lean();
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    res.json(submission);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/submissions/:id/approve — move from airlock into the main database
router.post("/:id/approve", requireAdmin, async (req: Request, res: Response) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    if (submission.status !== "pending") {
      res.status(400).json({ error: `Submission already ${submission.status}` });
      return;
    }

    // Move file from airlock into the main SLP directory
    const destDir = path.join(config.slpRootDir, "uploads");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, path.basename(submission.airlockPath));

    try {
      fs.renameSync(submission.airlockPath, destPath);
    } catch (moveErr) {
      sendError(res, moveErr);
      return;
    }

    // Create the replay record
    const stat = fs.statSync(destPath);
    const fileHash = crypto
      .createHash("md5")
      .update(`${stat.size}-${stat.mtimeMs}`)
      .digest("hex");

    let replay;
    try {
      replay = await Replay.create({
        filePath: destPath,
        fileHash,
        stageId: submission.stageId,
        stageName: submission.stageName,
        startAt: submission.startAt,
        duration: submission.duration,
        players: submission.players,
        winner: submission.winner,
        folderLabel: "uploads",
        indexedAt: new Date(),
      });
    } catch (dbErr) {
      // Move the file back to airlock so we don't lose it
      try { fs.renameSync(destPath, submission.airlockPath); } catch {}
      sendError(res, dbErr);
      return;
    }

    submission.status = "approved";
    submission.replayId = replay._id;
    submission.reviewedAt = new Date();
    await submission.save();

    res.json({ status: "approved", replayId: replay._id });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/submissions/:id/reject — reject and delete the file
router.post("/:id/reject", requireAdmin, async (req: Request, res: Response) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }
    if (submission.status !== "pending") {
      res.status(400).json({ error: `Submission already ${submission.status}` });
      return;
    }

    // Delete the file from the airlock
    if (fs.existsSync(submission.airlockPath)) {
      fs.unlinkSync(submission.airlockPath);
    }

    submission.status = "rejected";
    submission.reviewedAt = new Date();
    await submission.save();

    res.json({ status: "rejected" });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
