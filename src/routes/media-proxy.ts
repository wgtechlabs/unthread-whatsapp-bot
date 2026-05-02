import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { Request, Response } from "express";
import { Router } from "express";
import { config } from "../config";
import { sanitizeFileName } from "../services/attachment-validator";
import { getProxyToken } from "../services/media-proxy-store";
import type { MediaProxyTokenRecord } from "../types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_FILE_ID_PATTERN = /^F[A-Z0-9]+$/;

// Returns true when the given URL is on the configured Unthread API origin.
// The X-API-KEY credential must only be forwarded to that exact origin.
function isUnthreadApiUrl(url: string): boolean {
  try {
    const target = new URL(url);
    const apiOrigin = new URL(config.unthread.apiUrl);
    return target.origin === apiOrigin.origin;
  } catch {
    return false;
  }
}

export function resolveMediaProxyDownloadUrl(meta: MediaProxyTokenRecord): string | null {
  if (meta.downloadUrl) {
    return meta.downloadUrl;
  }

  if (meta.fileId) {
    // For image files, prefer Unthread's Slack file proxy endpoint when the Slack
    // team ID is known. This is the proven approach (mirrors unthread-telegram-bot):
    //   GET /slack/files/{fileId}/thumb?thumbSize=1024&teamId={teamId}
    // The team ID is auto-detected from the webhook file URL or set via SLACK_TEAM_ID.
    if (
      meta.slackTeamId &&
      meta.mimeType.startsWith("image/") &&
      SLACK_FILE_ID_PATTERN.test(meta.fileId)
    ) {
      return `${config.unthread.apiUrl}/slack/files/${encodeURIComponent(meta.fileId)}/thumb?thumbSize=1024&teamId=${encodeURIComponent(meta.slackTeamId)}`;
    }

    // Fall back to the generic Unthread file download endpoint for non-image files
    // or when the Slack team ID is not available.
    return `${config.unthread.apiUrl}/files/${encodeURIComponent(meta.fileId)}/download`;
  }

  return null;
}

export const mediaProxyRouter = Router();

// GET /media/:token
// Fetches and proxies a file stored in Unthread on behalf of Twilio.
// Tokens are short-lived and stored with TTL in Nuvex/Redis.
mediaProxyRouter.get("/:token", async (req: Request, res: Response) => {
  const rawToken = req.params.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  if (!token || !UUID_PATTERN.test(token)) {
    res.status(404).end();
    return;
  }

  let meta: Awaited<ReturnType<typeof getProxyToken>>;
  try {
    meta = await getProxyToken(token);
  } catch (error) {
    LogEngine.error("Media proxy: failed to retrieve token metadata", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).end();
    return;
  }

  if (!meta) {
    res.status(404).end();
    return;
  }

  // Resolve the download URL. Prefer urlPrivateDownload, fall back to Unthread's
  // conversation-scoped file endpoint.
  const downloadUrl = resolveMediaProxyDownloadUrl(meta);

  if (!downloadUrl) {
    LogEngine.error("Media proxy: no download URL available for token");
    res.status(404).end();
    return;
  }

  // Hard-reject any download URL that is not on the Unthread API origin.
  // All legitimate tokens are constructed with Unthread-origin URLs, so a
  // non-Unthread URL here indicates tampered or corrupted token data and
  // must not be proxied (prevents SSRF).
  if (!isUnthreadApiUrl(downloadUrl)) {
    LogEngine.error("Media proxy: download URL is not on the Unthread API origin — refusing", {
      fileName: meta.fileName,
    });
    res.status(403).end();
    return;
  }

  try {
    // Since the hard-reject above ensures downloadUrl is on the Unthread API
    // origin, always attach the X-API-KEY credential.
    const headers: Record<string, string> = { "X-API-KEY": config.unthread.apiKey };

    const fileRes = await fetch(downloadUrl, { headers });

    if (!fileRes.ok) {
      LogEngine.error("Media proxy: upstream file fetch failed", {
        status: fileRes.status,
        fileName: meta.fileName,
      });
      res.status(502).end();
      return;
    }

    const safeFileName = sanitizeFileName(meta.fileName);
    // sanitizeFileName already replaces " and \ with _ and strips control characters,
    // so safeFileName is safe to embed directly in the Content-Disposition header.
    res.setHeader("Content-Type", meta.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${safeFileName}"`);

    const contentLength = fileRes.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    if (fileRes.body) {
      // Convert the Web ReadableStream to a Node Readable and pipe to the
      // response so that backpressure and client aborts are handled correctly.
      const nodeStream = Readable.fromWeb(
        fileRes.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      await pipeline(nodeStream, res);
    } else {
      const buffer = await fileRes.arrayBuffer();
      res.end(Buffer.from(buffer));
    }
  } catch (error) {
    LogEngine.error("Media proxy: error streaming file", {
      error: error instanceof Error ? error.message : String(error),
      fileName: meta.fileName,
    });
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
});
