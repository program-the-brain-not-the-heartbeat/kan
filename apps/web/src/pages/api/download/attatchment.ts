import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { NextApiRequest, NextApiResponse } from "next";

import { withRateLimit } from "@kan/api/utils/rateLimit";

import { env } from "~/env";

function normalizeUploadsPath(pathname: string | undefined) {
  const trimmed = (pathname ?? "").trim();
  const value = trimmed.length > 0 ? trimmed : "/uploads";

  if (value === "/") {
    return "";
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function getStorageDriver() {
  const configuredDriver = env.KAN_STORAGE_DRIVER as unknown as
    | "s3"
    | "fs"
    | undefined;
  const storageDir = env.KAN_STORAGE_DIR as unknown as string | undefined;
  const s3Endpoint = env.S3_ENDPOINT as unknown as string | undefined;

  return configuredDriver ?? (storageDir ? "fs" : s3Endpoint ? "s3" : "s3");
}

function getContentType(filePath: string) {
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
    case ".json":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function getAllowedOrigins() {
  const candidates = [
    env.NEXT_PUBLIC_STORAGE_URL as unknown as string | undefined,
    env.NEXT_PUBLIC_BASE_URL as unknown as string | undefined,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  const origins = new Set<string>();
  for (const candidate of candidates) {
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Ignore invalid env values
    }
  }

  return origins;
}

export default withRateLimit(
  { points: 100, duration: 60 },
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    const { url, filename } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        message: "url parameter is required",
      });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ message: "Invalid url" });
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return res.status(400).json({ message: "Invalid url protocol" });
    }

    const allowedOrigins = getAllowedOrigins();
    if (allowedOrigins.size > 0 && !allowedOrigins.has(parsedUrl.origin)) {
      return res.status(400).json({ message: "Disallowed url" });
    }

    const rawFilename = typeof filename === "string" ? filename : "attachment";
    const downloadFilename = encodeURIComponent(rawFilename);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadFilename}"; filename*=UTF-8''${downloadFilename}`,
    );

    // If we're using filesystem storage and the URL points at our public uploads path,
    // serve directly from disk instead of bouncing through the reverse proxy.
    if (getStorageDriver() === "fs") {
      const storageDir = env.KAN_STORAGE_DIR as unknown as string | undefined;
      if (!storageDir) {
        return res
          .status(500)
          .json({ message: "KAN_STORAGE_DIR not configured" });
      }

      const uploadsPath = normalizeUploadsPath(
        env.NEXT_PUBLIC_UPLOADS_PATH as unknown as string | undefined,
      );

      if (uploadsPath && parsedUrl.pathname.startsWith(`${uploadsPath}/`)) {
        const remainder = parsedUrl.pathname.slice(uploadsPath.length + 1);
        const parts = remainder
          .split("/")
          .filter(Boolean)
          .map((p) => decodeURIComponent(p));

        const bucket = parts[0];
        const keyParts = parts.slice(1);

        if (!bucket || keyParts.length === 0) {
          return res.status(400).json({ message: "Invalid upload path" });
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(bucket)) {
          return res.status(400).json({ message: "Invalid bucket" });
        }

        if (keyParts.some((p) => p.length === 0 || p === "." || p === "..")) {
          return res.status(400).json({ message: "Invalid key" });
        }

        const uploadsRoot = path.resolve(storageDir, "uploads");
        const filePath = path.resolve(uploadsRoot, bucket, ...keyParts);

        if (!filePath.startsWith(`${uploadsRoot}${path.sep}`)) {
          return res.status(400).json({ message: "Invalid path" });
        }

        try {
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) {
            return res.status(404).json({ message: "Not found" });
          }

          res.setHeader("Content-Type", getContentType(filePath));
          res.setHeader("Content-Length", fileStat.size);
          return await pipeline(createReadStream(filePath), res);
        } catch (error: unknown) {
          if ((error as { code?: string }).code === "ENOENT") {
            return res.status(404).json({ message: "Not found" });
          }

          console.error("Error reading local attachment:", error);
          return res
            .status(500)
            .json({ message: "Failed to download attachment" });
        }
      }
    }

    // Fallback: fetch from upstream and stream to the client.
    try {
      const upstream = await fetch(parsedUrl, { redirect: "follow" });

      if (!upstream.ok) {
        return res.status(upstream.status).json({
          message: "Failed to fetch attachment",
        });
      }

      res.setHeader(
        "Content-Type",
        upstream.headers.get("Content-Type") ?? "application/octet-stream",
      );

      const body = upstream.body;
      if (!body) {
        return res.status(502).json({ message: "Upstream returned no body" });
      }

      // Node's Response.body is a web ReadableStream; convert it to a Node stream.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Readable } = await import("node:stream");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeStream = (Readable as any).fromWeb(body as any);
      return await pipeline(nodeStream, res);
    } catch (error) {
      console.error("Error downloading attachment:", error);
      return res.status(500).json({ message: "Failed to download attachment" });
    }
  },
);
