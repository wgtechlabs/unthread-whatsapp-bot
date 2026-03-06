import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { NuvexClient } from "@wgtechlabs/nuvex";
import type { NuvexConfig } from "@wgtechlabs/nuvex";
import { LogEngine } from "@wgtechlabs/log-engine";
import { config } from "./config";
import { setStorage } from "./services/customer-store";
import { twilioWebhookRouter } from "./routes/twilio-webhook";
import { UnthreadWebhookConsumer } from "./services/unthread-webhook-consumer";
import { startSessionTimer, stopSessionTimer } from "./services/session-timer";

// Read bot version from package.json
const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"));
const BOT_VERSION: string = pkg.version;

async function bootstrap() {
  let webhookConsumer: UnthreadWebhookConsumer | null = null;

  const nuvexConfig: NuvexConfig = {
    postgres: config.storage.postgres,
  };

  if (config.storage.redisUrl) {
    nuvexConfig.redis = { url: config.storage.redisUrl };
    LogEngine.info("Storage: Redis enabled");
  }

  const storage = await NuvexClient.initialize(nuvexConfig);
  setStorage(storage);
  LogEngine.info("Storage: Nuvex initialized");

  if (config.webhook.redisUrl) {
    webhookConsumer = new UnthreadWebhookConsumer({
      redisUrl: config.webhook.redisUrl,
      queueName: config.webhook.queueName,
    });
    await webhookConsumer.start();
    LogEngine.info("Webhook queue consumer enabled", {
      queueName: config.webhook.queueName,
    });
  }

  // Start session expiry timer (sends pre-expiry warnings before 24h WhatsApp window closes)
  startSessionTimer();

  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const health = await storage.healthCheck();
    res.json({ status: "ok", version: BOT_VERSION, storage: health, timestamp: new Date().toISOString() });
  });

  app.use("/webhooks/twilio", twilioWebhookRouter);

  app.listen(config.port, () => {
    LogEngine.log(`Unthread WhatsApp Bot v${BOT_VERSION} running on port ${config.port}`);
    LogEngine.info("Twilio webhook:   POST /webhooks/twilio");
    LogEngine.info("Health check:     GET  /health");
  });

  const shutdown = async () => {
    try {
      stopSessionTimer();
      if (webhookConsumer) {
        await webhookConsumer.stop();
      }
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  LogEngine.error("Failed to start server", { error: err });
  process.exit(1);
});
