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

// Read bot version from package.json
const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"));
const BOT_VERSION: string = pkg.version;

async function logStorageDiagnostics(storage: NuvexClient): Promise<void> {
  LogEngine.info("Storage diagnostics: configuration", {
    hasPostgres: true,
    postgresHost: config.storage.postgres.host,
    postgresDatabase: config.storage.postgres.database,
    hasRedis: Boolean(config.storage.redisUrl),
    hasWebhookRedis: Boolean(config.webhook.redisUrl),
  });

  try {
    const health = await storage.healthCheck();
    LogEngine.info("Storage diagnostics: health check", health);
  } catch (error) {
    LogEngine.error("Storage diagnostics: health check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const diagnosticsKey = `diagnostics:startup:${Date.now()}`;
  const diagnosticsValue = {
    botVersion: BOT_VERSION,
    timestamp: new Date().toISOString(),
  };

  try {
    const writeOk = await storage.set(diagnosticsKey, diagnosticsValue);
    LogEngine.info("Storage diagnostics: write test", { diagnosticsKey, writeOk });

    const persistentRead = await storage.get<typeof diagnosticsValue>(diagnosticsKey, { skipCache: true });
    LogEngine.info("Storage diagnostics: persistent read test", {
      diagnosticsKey,
      readOk: persistentRead !== null,
      value: persistentRead,
    });

    const deleteOk = await storage.delete(diagnosticsKey);
    LogEngine.info("Storage diagnostics: delete test", { diagnosticsKey, deleteOk });
  } catch (error) {
    LogEngine.error("Storage diagnostics: roundtrip failed", {
      diagnosticsKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const metrics = storage.getMetrics();
    LogEngine.info("Storage diagnostics: metrics snapshot", metrics);
  } catch (error) {
    LogEngine.warn("Storage diagnostics: metrics unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  await logStorageDiagnostics(storage);

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
