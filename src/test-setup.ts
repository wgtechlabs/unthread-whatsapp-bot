// ponytail: bun test preload (see bunfig.toml) — sets dummy env vars once,
// before any test file imports config.ts, so config's eager env validation
// never depends on cross-file process.env mutation order. See issue #14.
process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test-token";
process.env.TWILIO_WHATSAPP_NUMBER ||= "whatsapp:+14155550123";
process.env.TWILIO_WEBHOOK_URL ||= "https://example.com/webhooks/twilio";
process.env.UNTHREAD_API_KEY ||= "test-unthread-key";
process.env.UNTHREAD_SLACK_CHANNEL_ID ||= "test-channel";
process.env.POSTGRES_URL ||= "postgresql://localhost:5432/test_db";
