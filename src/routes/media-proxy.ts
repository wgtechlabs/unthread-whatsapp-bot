import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { Response as ExpressResponse, Request } from "express";
import { Router } from "express";
import { config } from "../config";
import { sanitizeFileName } from "../services/attachment-validator";
import { getProxyToken } from "../services/media-proxy-store";
import type { MediaProxyTokenRecord } from "../types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_FILE_ID_PATTERN = /^F[A-Z0-9]+$/;
const UPSTREAM_FETCH_ATTEMPTS = 8;
const UPSTREAM_FETCH_RETRY_DELAY_MS = 1000;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryMediaProxyUpstreamFetch(status: number): boolean {
  return status === 404 || status === 409 || status === 425;
}

function buildSlackThumbnailUrl(fileId: string, slackTeamId: string): string {
  return `${config.unthread.apiUrl}/slack/files/${encodeURIComponent(fileId)}/thumb?thumbSize=1024&teamId=${encodeURIComponent(slackTeamId)}`;
}

// Dashboard-origin attachments use UUID file IDs. These are only downloadable
// through Unthread's documented conversation-scoped endpoint; the older
// /files/{fileId}/download path returns persistent 404s for this flow.
function buildConversationFileUrl(conversationId: string, fileId: string): string {
  return `${config.unthread.apiUrl}/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/full`;
}

function buildGenericFileDownloadUrl(fileId: string): string {
  return `${config.unthread.apiUrl}/files/${encodeURIComponent(fileId)}/download`;
}

async function fetchUnthreadFileWithRetry(
  downloadUrl: string,
  headers: Record<string, string>,
  fileName: string,
): Promise<Response> {
  for (let attempt = 1; attempt <= UPSTREAM_FETCH_ATTEMPTS; attempt++) {
    const response = await fetch(downloadUrl, { headers });
    if (
      response.ok ||
      !shouldRetryMediaProxyUpstreamFetch(response.status) ||
      attempt === UPSTREAM_FETCH_ATTEMPTS
    ) {
      return response;
    }

    await response.body?.cancel(`Retrying transient upstream status ${response.status}`);
    LogEngine.debug("Media proxy: upstream file not ready, retrying", {
      status: response.status,
      fileName,
      attempt,
      maxAttempts: UPSTREAM_FETCH_ATTEMPTS,
    });
    await delay(UPSTREAM_FETCH_RETRY_DELAY_MS);
  }

  throw new Error("Media proxy upstream retry loop exhausted unexpectedly");
}

export function resolveMediaProxyDownloadUrl(meta: MediaProxyTokenRecord): string | null {
  if (meta.downloadUrl) {
    return meta.downloadUrl;
  }

  if (meta.fileId) {
    // Do not treat every image as a Slack file. Slack thumbnails only work for
    // Slack file IDs (F...) with a team ID. Dashboard UUID attachments must use
    // buildConversationFileUrl instead.
    if (
      meta.slackTeamId &&
      meta.mimeType.startsWith("image/") &&
      SLACK_FILE_ID_PATTERN.test(meta.fileId)
    ) {
      return buildSlackThumbnailUrl(meta.fileId, meta.slackTeamId);
    }

    if (meta.conversationId) {
      return buildConversationFileUrl(meta.conversationId, meta.fileId);
    }

    // Older tokens may not have conversationId. Keep the generic endpoint as a
    // last-resort fallback for those records.
    return buildGenericFileDownloadUrl(meta.fileId);
  }

  return null;
}

export const mediaProxyRouter = Router();

// GET /media/:token
// Fetches and proxies a file stored in Unthread on behalf of Twilio.
// This route is intentionally narrow: tokens are short-lived, download targets
// must stay on the Unthread API origin, and the Unthread API key must never be
// forwarded to arbitrary URLs.
mediaProxyRouter.get("/:token", async (req: Request, res: ExpressResponse) => {
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

  // Resolve the download URL. Prefer a previously validated direct Unthread URL,
  // then fall back to the verified conversation-scoped file endpoint.
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
    LogEngine.error("Media proxy: download URL is not on the Unthread API origin; refusing", {
      fileName: meta.fileName,
    });
    res.status(403).end();
    return;
  }

  try {
    // Since the hard-reject above ensures downloadUrl is on the Unthread API
    // origin, always attach the X-API-KEY credential.
    const headers: Record<string, string> = { "X-API-KEY": config.unthread.apiKey };

    const fileRes = await fetchUnthreadFileWithRetry(downloadUrl, headers, meta.fileName);

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
