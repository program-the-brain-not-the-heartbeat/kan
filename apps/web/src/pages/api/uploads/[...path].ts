import type { NextApiRequest, NextApiResponse } from "next";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { env } from "~/env";

const getContentType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const configuredDriver = env.KAN_STORAGE_DRIVER as unknown as
    | "s3"
    | "fs"
    | undefined;
  const storageDir = env.KAN_STORAGE_DIR as unknown as string | undefined;
  const s3Endpoint = env.S3_ENDPOINT as unknown as string | undefined;

  const driver =
    configuredDriver ?? (storageDir ? "fs" : s3Endpoint ? "s3" : "s3");

  if (driver !== "fs") {
    return res.status(404).json({ error: "Not found" });
  }

  if (!storageDir) {
    return res.status(500).json({ error: "KAN_STORAGE_DIR not configured" });
  }

  const pathParts = req.query.path;
  const parts = Array.isArray(pathParts)
    ? pathParts
    : typeof pathParts === "string"
      ? [pathParts]
      : [];

  const bucket = parts[0];
  const keyParts = parts.slice(1);

  if (!bucket || keyParts.length === 0) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(bucket)) {
    return res.status(400).json({ error: "Invalid bucket" });
  }

  if (keyParts.some((p) => p.length === 0 || p === "." || p === "..")) {
    return res.status(400).json({ error: "Invalid key" });
  }

  const uploadsRoot = path.resolve(storageDir, "uploads");
  const filePath = path.resolve(uploadsRoot, bucket, ...keyParts);

  if (!filePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      return res.status(404).json({ error: "Not found" });
    }

    res.setHeader("Content-Type", getContentType(filePath));
    res.setHeader("Content-Length", fileStat.size);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (req.method === "HEAD") {
      return res.status(200).end();
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => {
      // If the stream errors mid-flight, just terminate.
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read file" });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") {
      return res.status(404).json({ error: "Not found" });
    }

    console.error("Failed to serve upload", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
