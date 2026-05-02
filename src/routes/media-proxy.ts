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

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function readRecordSize(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  return undefined;
}

export function shouldRetryMediaProxyUpstreamFetch(status: number): boolean {
  return status === 404 || status === 409 || status === 425;
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

function readDownloadUrl(record: Record<string, unknown>): string {
  return (
    readRecordString(record, "urlPrivateDownload") ||
    readRecordString(record, "url_private_download") ||
    readRecordString(record, "downloadUrl") ||
    readRecordString(record, "download_url") ||
    readRecordString(record, "urlPrivate") ||
    readRecordString(record, "url_private") ||
    readRecordString(record, "url")
  );
}

function findNestedDownloadUrl(value: unknown, depth = 0): string {
  if (depth > 6 || !value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedDownloadUrl(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  const record = value as Record<string, unknown>;
  const directUrl = readDownloadUrl(record);
  if (directUrl) return directUrl;

  for (const nested of Object.values(record)) {
    const found = findNestedDownloadUrl(nested, depth + 1);
    if (found) return found;
  }

  return "";
}

function recordMatchesAttachment(
  record: Record<string, unknown>,
  meta: MediaProxyTokenRecord,
): boolean {
  const ids = ["id", "fileId", "file_id", "attachmentId", "attachment_id"]
    .map((key) => readRecordString(record, key))
    .filter(Boolean);

  if (meta.fileId && ids.includes(meta.fileId)) {
    return true;
  }

  const names = ["name", "fileName", "filename", "title"]
    .map((key) => readRecordString(record, key))
    .filter(Boolean);
  if (!names.includes(meta.fileName)) {
    return false;
  }

  const size = readRecordSize(record, "size") ?? readRecordSize(record, "fileSize");
  if (meta.fileSize !== undefined && size !== undefined && size !== meta.fileSize) {
    return false;
  }

  const mimeType =
    readRecordString(record, "mimetype") ||
    readRecordString(record, "mimeType") ||
    readRecordString(record, "contentType") ||
    readRecordString(record, "content_type") ||
    readRecordString(record, "type");
  return !mimeType || mimeType === meta.mimeType;
}

export function findAttachmentDownloadUrl(
  value: unknown,
  meta: MediaProxyTokenRecord,
  depth = 0,
): string {
  if (depth > 8 || !value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAttachmentDownloadUrl(item, meta, depth + 1);
      if (found) return found;
    }
    return "";
  }

  const record = value as Record<string, unknown>;
  if (recordMatchesAttachment(record, meta)) {
    const url = findNestedDownloadUrl(record);
    if (url) return url;
  }

  for (const nested of Object.values(record)) {
    const found = findAttachmentDownloadUrl(nested, meta, depth + 1);
    if (found) return found;
  }

  return "";
}

async function resolveAttachmentDownloadUrlFromConversation(
  meta: MediaProxyTokenRecord,
  headers: Record<string, string>,
): Promise<string | null> {
  if (!meta.conversationId || !meta.fileId) {
    return null;
  }

  const messagesUrl = `${config.unthread.apiUrl}/conversations/${encodeURIComponent(meta.conversationId)}/messages`;
  const response = await fetch(messagesUrl, {
    headers: { ...headers, Accept: "application/json" },
  });

  if (!response.ok) {
    LogEngine.debug("Media proxy: conversation message lookup failed", {
      status: response.status,
      fileName: meta.fileName,
    });
    return null;
  }

  const payload = (await response.json()) as unknown;
  const downloadUrl = findAttachmentDownloadUrl(payload, meta);
  if (!downloadUrl) {
    return null;
  }

  if (!isUnthreadApiUrl(downloadUrl)) {
    LogEngine.warn("Media proxy: resolved attachment URL is not on the Unthread API origin", {
      fileName: meta.fileName,
    });
    return null;
  }

  return downloadUrl;
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

    let fileRes: Response | null = null;
    let triedConversationResolver = false;

    if (meta.fileId && UUID_PATTERN.test(meta.fileId) && meta.conversationId) {
      triedConversationResolver = true;
      const resolvedDownloadUrl = await resolveAttachmentDownloadUrlFromConversation(meta, headers);
      if (resolvedDownloadUrl) {
        LogEngine.debug("Media proxy: using resolved attachment download URL", {
          fileName: meta.fileName,
        });
        fileRes = await fetchUnthreadFileWithRetry(resolvedDownloadUrl, headers, meta.fileName);
      }
    }

    fileRes ??= await fetchUnthreadFileWithRetry(downloadUrl, headers, meta.fileName);

    if (
      !fileRes.ok &&
      fileRes.status === 404 &&
      meta.fileId &&
      meta.conversationId &&
      !triedConversationResolver
    ) {
      const resolvedDownloadUrl = await resolveAttachmentDownloadUrlFromConversation(meta, headers);
      if (resolvedDownloadUrl && resolvedDownloadUrl !== downloadUrl) {
        await fileRes.body?.cancel("Retrying with resolved attachment download URL");
        LogEngine.debug("Media proxy: retrying with resolved attachment download URL", {
          fileName: meta.fileName,
        });
        fileRes = await fetchUnthreadFileWithRetry(resolvedDownloadUrl, headers, meta.fileName);
      }
    }

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
