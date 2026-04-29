import { LogEngine } from "@wgtechlabs/log-engine";
import type { Request, Response } from "express";
import { Router } from "express";
import { config } from "../config";
import { sanitizeFileName } from "../services/attachment-validator";
import { getProxyToken } from "../services/media-proxy-store";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Resolve the download URL. Prefer urlPrivateDownload, fall back to fileId endpoint.
  let downloadUrl = meta.downloadUrl ?? null;
  if (!downloadUrl && meta.fileId) {
    downloadUrl = `${config.unthread.apiUrl}/files/${meta.fileId}/download`;
  }

  if (!downloadUrl) {
    LogEngine.error("Media proxy: no download URL available for token");
    res.status(404).end();
    return;
  }

  try {
    const fileRes = await fetch(downloadUrl, {
      headers: { "X-API-KEY": config.unthread.apiKey },
    });

    if (!fileRes.ok) {
      LogEngine.error("Media proxy: upstream file fetch failed", {
        status: fileRes.status,
        fileName: meta.fileName,
      });
      res.status(502).end();
      return;
    }

    const safeFileName = sanitizeFileName(meta.fileName);
    // Escape double-quote characters in the filename to prevent Content-Disposition injection.
    const escapedFileName = safeFileName.replace(/"/g, '\\"');
    res.setHeader("Content-Type", meta.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${escapedFileName}"`);

    const contentLength = fileRes.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    if (fileRes.body) {
      const reader = fileRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
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
