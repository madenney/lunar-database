import fs from "fs";
import { S3Client, DeleteObjectCommand, GetObjectCommand, CopyObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
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
      // The client is a long-lived singleton, so a keep-alive socket that B2
      // has silently dropped would otherwise make the next request hang until
      // the OS TCP timeout (tens of seconds). Bound both phases so a dead
      // socket aborts quickly and the SDK retries on a fresh connection.
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3000,
        requestTimeout: 5000,
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
