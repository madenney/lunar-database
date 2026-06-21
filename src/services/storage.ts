import fs from "fs";
import { S3Client, DeleteObjectCommand, GetObjectCommand, CopyObjectCommand, HeadBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { Agent as HttpsAgent } from "https";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { config } from "../config";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    if (!config.s3Configured) {
      throw new Error("S3 credentials not configured (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)");
    }
    client = new S3Client({
      region: config.s3Region,
      endpoint: config.s3Endpoint,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
      // Force IPv4. B2's DNS returns both A and AAAA records, but this host's
      // IPv6 route to Backblaze is unreachable. The service runs on Node 18,
      // which lacks "happy eyeballs" (autoSelectFamily, default only in Node 20+),
      // so it picks the AAAA address and the connection hangs until timeout.
      // family:4 pins every connection to IPv4. The timeouts are a backstop so a
      // dead/stale socket aborts fast and the SDK retries instead of hanging.
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3000,
        requestTimeout: 5000,
        httpsAgent: new HttpsAgent({ keepAlive: true, family: 4 }),
      }),
    });
  }
  return client;
}

export async function uploadToStorage(
  filePath: string,
  key: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const body = fs.createReadStream(filePath);
  const stat = fs.statSync(filePath);

  try {
    const upload = new Upload({
      client: getClient(),
      params: {
        Bucket: config.s3BucketName,
        Key: key,
        Body: body,
        ContentLength: stat.size,
        ContentType: "application/x-tar",
      },
    });

    if (onProgress) {
      upload.on("httpUploadProgress", (progress) => {
        onProgress(progress.loaded ?? 0, progress.total ?? stat.size);
      });
    }

    await upload.done();
  } finally {
    body.destroy();
  }
}

/** Generate a presigned download URL (1 hour TTL, max 24 hours). */
export async function getPresignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const MAX_EXPIRY = 24 * 60 * 60; // 24 hours
  const bounded = Math.min(Math.max(60, expiresInSeconds), MAX_EXPIRY);
  const command = new GetObjectCommand({
    Bucket: config.s3BucketName,
    Key: key,
  });
  return getSignedUrl(getClient(), command, { expiresIn: bounded });
}

/**
 * HEAD an object: returns its size in bytes. Throws if the object is missing
 * (NotFound) or the storage backend is erroring (e.g. B2 daily-cap → 503). Used
 * to confirm an object is downloadable before minting a presigned URL.
 */
export async function headObject(key: string): Promise<{ size: number }> {
  const res = await getClient().send(
    new HeadObjectCommand({ Bucket: config.s3BucketName, Key: key })
  );
  return { size: res.ContentLength ?? 0 };
}

/**
 * Classify an S3/B2 error (from a HEAD/GET) for client-facing handling.
 *   "cap"      = B2 daily download/bandwidth cap exhausted (503) or throttling
 *   "notfound" = object missing
 *   "other"    = anything else (treat as a 5xx)
 */
export function classifyStorageError(err: unknown): "notfound" | "cap" | "other" {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  const name = e?.name ?? "";
  if (status === 404 || name === "NotFound" || name === "NoSuchKey") return "notfound";
  if (status === 503 || /SlowDown|ServiceUnavailable|TooManyRequests/i.test(name)) return "cap";
  if ((status === 403 || status === 429) && /cap|exceeded/i.test(e?.message ?? "")) return "cap";
  return "other";
}

/** Server-side copy within the bucket (used to move bundles between the
 *  ephemeral `jobs/` and permanent `archive/` prefixes when pinning). */
export async function copyObject(srcKey: string, destKey: string): Promise<void> {
  await getClient().send(
    new CopyObjectCommand({
      Bucket: config.s3BucketName,
      CopySource: encodeURI(`${config.s3BucketName}/${srcKey}`),
      Key: destKey,
      ContentType: "application/x-tar",
    })
  );
}

export async function deleteFromStorage(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({
      Bucket: config.s3BucketName,
      Key: key,
    })
  );
}

/**
 * Verify the object-storage bucket is reachable with the configured credentials.
 * Throws if not configured or the bucket can't be reached. Used by the admin
 * health check to confirm uploads/downloads would actually work.
 */
export async function pingStorage(): Promise<void> {
  if (!config.s3Configured) {
    throw new Error("S3 credentials not configured");
  }
  await getClient().send(new HeadBucketCommand({ Bucket: config.s3BucketName }));
}
