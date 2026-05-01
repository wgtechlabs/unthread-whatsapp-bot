function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalIntEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Derive the public base URL for media proxy tokens from TWILIO_WEBHOOK_URL when
// PUBLIC_BASE_URL is not explicitly provided. Extracts the protocol and host only.
function resolvePublicBaseUrl(webhookUrl: string): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  try {
    const parsed = new URL(webhookUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function optionalBooleanEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeNodeEnv(
  value: string | undefined,
): "development" | "production" | "test" | "staging" {
  const normalized = value?.trim().toLowerCase();

  switch (normalized) {
    case "prod":
    case "production":
      return "production";
    case "test":
      return "test";
    case "stage":
    case "staging":
      return "staging";
    default:
      return "development";
  }
}

export const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
const UNTHREAD_API_URL = "https://api.unthread.io/api";

function parsePostgresUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "5432", 10),
    database: parsed.pathname.replace("/", ""),
    user: parsed.username,
    password: parsed.password,
    autoSetupSchema: optionalBooleanEnv("NUVEX_AUTO_SETUP_SCHEMA", nodeEnv !== "production"),
  };
}

export const config = {
  nodeEnv,
  port: parseInt(optionalEnv("PORT", "3000"), 10),

  twilio: {
    accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
    authToken: requireEnv("TWILIO_AUTH_TOKEN"),
    whatsappNumber: requireEnv("TWILIO_WHATSAPP_NUMBER"),
    webhookUrl: requireEnv("TWILIO_WEBHOOK_URL"),
  },

  unthread: {
    apiKey: requireEnv("UNTHREAD_API_KEY"),
    apiUrl: UNTHREAD_API_URL,
    channelId: requireEnv("UNTHREAD_SLACK_CHANNEL_ID"),
    webhookSecret: optionalEnv("UNTHREAD_WEBHOOK_SECRET", ""),
    // Slack workspace team ID required for the /slack/files/{id}/thumb download endpoint.
    // Auto-detected from webhook file URLs when not explicitly set.
    slackTeamId: optionalEnv("SLACK_TEAM_ID", ""),
  },

  storage: {
    postgres: parsePostgresUrl(requireEnv("POSTGRES_URL")),
    redisUrl: optionalEnv("REDIS_URL", ""),
  },

  webhook: {
    redisUrl: optionalEnv("WEBHOOK_REDIS_URL", ""),
    queueName: optionalEnv("WEBHOOK_QUEUE_NAME", "unthread-events"),
  },

  media: {
    // Public base URL for media proxy tokens served to Twilio.
    // Set PUBLIC_BASE_URL explicitly or derive from TWILIO_WEBHOOK_URL.
    publicBaseUrl: resolvePublicBaseUrl(process.env.TWILIO_WEBHOOK_URL ?? ""),
    // How long (seconds) a media proxy token remains valid. Default: 600 (10 minutes).
    tokenTtlSeconds: optionalIntEnv("MEDIA_TOKEN_TTL_SECONDS", 600),
    // Maximum inbound attachment size in bytes. Default: 16 MB.
    maxAttachmentSizeBytes: optionalIntEnv("MAX_ATTACHMENT_SIZE_BYTES", 16 * 1024 * 1024),
  },
} as const;
