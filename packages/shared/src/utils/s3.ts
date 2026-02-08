import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "next-runtime-env";

export type StorageDriver = "s3" | "fs";

function normalizePublicPath(pathname: string | undefined, fallback: string) {
  const trimmed = (pathname ?? "").trim();
  const value = trimmed.length > 0 ? trimmed : fallback;

  if (value === "/") {
    return "";
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function joinUrl(base: string, ...parts: string[]) {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const cleaned = parts
    .filter(Boolean)
    .map((p) => p.replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter((p) => p.length > 0);

  if (cleaned.length === 0) {
    return trimmedBase;
  }

  return `${trimmedBase}/${cleaned.join("/")}`;
}

export function getStorageDriver(): StorageDriver {
  const explicit = process.env.KAN_STORAGE_DRIVER?.toLowerCase();
  if (explicit === "fs" || explicit === "s3") {
    return explicit;
  }

  if (process.env.S3_ENDPOINT) {
    return "s3";
  }

  if (process.env.KAN_STORAGE_DIR) {
    return "fs";
  }

  return "s3";
}

function getUploadsPublicPath() {
  return normalizePublicPath(env("NEXT_PUBLIC_UPLOADS_PATH"), "/uploads");
}

function getPublicObjectUrl(bucket: string, key: string) {
  const storageUrl = env("NEXT_PUBLIC_STORAGE_URL");
  if (!storageUrl) {
    return null;
  }

  const uploadsPath = getUploadsPublicPath();
  return joinUrl(storageUrl, uploadsPath, bucket, key);
}

export function createS3Client() {
  const credentials =
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined;

  return new S3Client({
    region: process.env.S3_REGION ?? "",
    endpoint: process.env.S3_ENDPOINT ?? "",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials,
  });
}

export async function generateUploadUrl(
  bucket: string,
  key: string,
  contentType: string,
  expiresIn = 3600,
) {
  if (getStorageDriver() === "fs") {
    throw new Error("generateUploadUrl is not supported for fs storage");
  }

  const client = createS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      // Don't set ACL for private files
    }),
    { expiresIn },
  );
}

export async function generateDownloadUrl(
  bucket: string,
  key: string,
  expiresIn = 3600,
) {
  if (getStorageDriver() === "fs") {
    const url = getPublicObjectUrl(bucket, key);
    if (!url) {
      throw new Error("Storage URL not configured");
    }

    return url;
  }

  const client = createS3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
    { expiresIn },
  );
}

export async function deleteObject(bucket: string, key: string) {
  if (getStorageDriver() === "fs") {
    const storageDir = process.env.KAN_STORAGE_DIR;
    if (!storageDir) {
      throw new Error("KAN_STORAGE_DIR is required for fs storage");
    }

    const [{ unlink }] = await Promise.all([import("node:fs/promises")]);

    const path = await import("node:path");

    const uploadsRoot = path.resolve(storageDir, "uploads");
    const candidate = path.resolve(
      uploadsRoot,
      bucket,
      ...key.split("/").filter(Boolean),
    );

    if (
      !candidate.startsWith(`${uploadsRoot}${path.sep}`) &&
      candidate !== uploadsRoot
    ) {
      throw new Error("Invalid storage key");
    }

    try {
      await unlink(candidate);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "ENOENT") {
        return;
      }

      throw error;
    }

    return;
  }

  const client = createS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}

/**
 * Generate presigned URL for an avatar image
 * Returns the URL as-is if it's already a full URL (external provider)
 * Returns presigned URL if it's an S3 key
 * Returns null if image key is missing, bucket is not configured, or URL generation fails
 */
export async function generateAvatarUrl(
  imageKey: string | null | undefined,
  expiresIn = 86400, // 24 hours
): Promise<string | null> {
  if (!imageKey) {
    return null;
  }

  if (imageKey.startsWith("http://") || imageKey.startsWith("https://")) {
    return imageKey;
  }

  const bucket = env("NEXT_PUBLIC_AVATAR_BUCKET_NAME");
  if (!bucket) {
    return null;
  }

  if (getStorageDriver() === "fs") {
    return getPublicObjectUrl(bucket, imageKey);
  }

  try {
    return await generateDownloadUrl(bucket, imageKey, expiresIn);
  } catch {
    // If URL generation fails, return null
    return null;
  }
}

/**
 * Generate presigned URL for an attachment
 * Returns null if attachment key is missing, bucket is not configured, or URL generation fails
 */
export async function generateAttachmentUrl(
  attachmentKey: string | null | undefined,
  expiresIn = 86400, // 24 hours
): Promise<string | null> {
  if (!attachmentKey) {
    return null;
  }

  const bucket = env("NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME");
  if (!bucket) {
    return null;
  }

  if (getStorageDriver() === "fs") {
    return getPublicObjectUrl(bucket, attachmentKey);
  }

  try {
    return await generateDownloadUrl(bucket, attachmentKey, expiresIn);
  } catch {
    // If URL generation fails, return null
    return null;
  }
}
