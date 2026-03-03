import fs from "fs";
import { S3Client, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    if (!config.r2Configured) {
      throw new Error("R2 credentials not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
    }
    client = new S3Client({
      region: "auto",
      endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    });
  }
  return client;
}

export async function uploadToR2(
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
        Bucket: config.r2BucketName,
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

export async function getPresignedDownloadUrl(key: string, expiresInSeconds = 48 * 60 * 60): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.r2BucketName,
    Key: key,
  });

  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}

export async function deleteFromR2(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({
      Bucket: config.r2BucketName,
      Key: key,
    })
  );
}
