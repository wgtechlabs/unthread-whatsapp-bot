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

function parsePostgresUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "5432", 10),
    database: parsed.pathname.replace("/", ""),
    user: parsed.username,
    password: parsed.password,
    autoSetupSchema: optionalBooleanEnv("NUVEX_AUTO_SETUP_SCHEMA", true),
  };
}

export const config = {
  nodeEnv,
  port: parseInt(optionalEnv("PORT", "3000"), 10),

  twilio: {
    accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
    authToken: requireEnv("TWILIO_AUTH_TOKEN"),
    whatsappNumber: requireEnv("TWILIO_WHATSAPP_NUMBER"),
  },

  unthread: {
    apiKey: requireEnv("UNTHREAD_API_KEY"),
    apiUrl: optionalEnv("UNTHREAD_API_URL", "https://api.unthread.io/api"),
    channelId: requireEnv("UNTHREAD_SLACK_CHANNEL_ID"),
    webhookSecret: optionalEnv("UNTHREAD_WEBHOOK_SECRET", ""),
  },

  storage: {
    postgres: parsePostgresUrl(requireEnv("POSTGRES_URL")),
    redisUrl: optionalEnv("REDIS_URL", ""),
  },

  webhook: {
    redisUrl: optionalEnv("WEBHOOK_REDIS_URL", ""),
    queueName: optionalEnv("WEBHOOK_QUEUE_NAME", "unthread-events"),
  },
} as const;
