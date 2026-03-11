import fs from "fs";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
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

export function getPublicDownloadUrl(key: string): string {
  if (!config.publicDownloadBase) {
    throw new Error("PUBLIC_DOWNLOAD_BASE not configured");
  }
  return `${config.publicDownloadBase}/${key}`;
}

export async function deleteFromStorage(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({
      Bucket: config.s3BucketName,
      Key: key,
    })
  );
}
