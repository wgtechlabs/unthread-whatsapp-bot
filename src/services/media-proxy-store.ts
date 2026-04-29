import { randomUUID } from "node:crypto";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { NuvexClient } from "@wgtechlabs/nuvex";
import { config } from "../config";
import type { MediaProxyTokenRecord } from "../types";

const NS_MEDIA_PROXY = "wa:media-proxy:token";

let _storage: NuvexClient | null = null;

export function initializeMediaProxyStore(client: NuvexClient): void {
  _storage = client;
}

function storage(): NuvexClient {
  if (!_storage) {
    throw new Error("Media proxy store not initialized. Call initializeMediaProxyStore() first.");
  }
  return _storage;
}

// Store a media proxy token with TTL. Returns the generated token string.
export async function storeProxyToken(
  record: Omit<MediaProxyTokenRecord, "token" | "expiresAt">,
): Promise<string> {
  const token = randomUUID();
  const ttlSeconds = config.media.tokenTtlSeconds;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const meta: MediaProxyTokenRecord = { ...record, token, expiresAt };
  const key = `${NS_MEDIA_PROXY}:${token}`;

  const stored = await storage().set(key, meta, { ttl: ttlSeconds });
  if (!stored) {
    LogEngine.error("Failed to store media proxy token metadata");
    throw new Error("Failed to store media proxy token");
  }

  return token;
}

// Retrieve token metadata. Returns null for unknown, expired, or invalid tokens.
export async function getProxyToken(token: string): Promise<MediaProxyTokenRecord | null> {
  const key = `${NS_MEDIA_PROXY}:${token}`;
  const stored = await storage().get<MediaProxyTokenRecord>(key);

  if (!stored || typeof stored !== "object") {
    return null;
  }

  // Double-check expiry even when Redis TTL may have already cleared the key
  if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
    LogEngine.debug("Media proxy token has expired", { expiresAt: stored.expiresAt });
    return null;
  }

  return stored;
}
