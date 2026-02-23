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

function parsePostgresUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "5432", 10),
    database: parsed.pathname.replace("/", ""),
    user: parsed.username,
    password: parsed.password,
  };
}

export const config = {
  port: parseInt(optionalEnv("PORT", "3000"), 10),

  twilio: {
    accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
    authToken: requireEnv("TWILIO_AUTH_TOKEN"),
    whatsappNumber: requireEnv("TWILIO_WHATSAPP_NUMBER"),
  },

  unthread: {
    apiKey: requireEnv("UNTHREAD_API_KEY"),
    apiUrl: optionalEnv("UNTHREAD_API_URL", "https://api.unthread.io/api"),
    webhookSecret: optionalEnv("UNTHREAD_WEBHOOK_SECRET", ""),
  },

  storage: {
    postgres: parsePostgresUrl(requireEnv("POSTGRES_URL")),
    redisUrl: optionalEnv("REDIS_URL", ""),
  },
} as const;
