import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LogEngine, LogMode } from "@wgtechlabs/log-engine";
import type { NuvexConfig, StorageOptions } from "@wgtechlabs/nuvex";
import { NuvexClient } from "@wgtechlabs/nuvex";
import express from "express";
import { config } from "./config";
import { mediaProxyRouter } from "./routes/media-proxy";
import { twilioWebhookRouter } from "./routes/twilio-webhook";
import { setStorage } from "./services/customer-store";
import { initializeMediaProxyStore } from "./services/media-proxy-store";
import { UnthreadWebhookConsumer } from "./services/unthread-webhook-consumer";

// Read bot version from package.json
const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"));
const BOT_VERSION: string = pkg.version;

LogEngine.configure({
  mode:
    config.nodeEnv === "production"
      ? LogMode.INFO
      : config.nodeEnv === "test"
        ? LogMode.ERROR
        : LogMode.DEBUG,
  format: {
    includeIsoTimestamp: false,
    includeLocalTime: false,
  },
});

async function logStorageDiagnostics(storage: NuvexClient): Promise<void> {
  LogEngine.info("Storage diagnostics: configuration", {
    hasPostgres: Boolean(config.storage.postgres.host && config.storage.postgres.database),
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
  const diagnosticsWriteOptions: StorageOptions = { ttl: 60 };

  const layerTests: Array<{
    label: string;
    layer?: "memory" | "redis" | "postgres";
    readOptions?: StorageOptions;
  }> = [
    { label: "default" },
    { label: "memory", layer: "memory", readOptions: { layer: "memory" as never } },
    { label: "redis", layer: "redis", readOptions: { layer: "redis" as never } },
    { label: "postgres", layer: "postgres", readOptions: { layer: "postgres" as never } },
  ];

  let defaultWriteOk = false;
  try {
    defaultWriteOk = await storage.set(diagnosticsKey, diagnosticsValue, diagnosticsWriteOptions);
    LogEngine.info("Storage diagnostics: write test", { diagnosticsKey, writeOk: defaultWriteOk });

    const persistentRead = await storage.get<typeof diagnosticsValue>(diagnosticsKey, {
      skipCache: true,
    });
    LogEngine.info("Storage diagnostics: persistent read test", {
      diagnosticsKey,
      readOk: persistentRead !== null,
      value: persistentRead,
    });
  } catch (error) {
    LogEngine.error("Storage diagnostics: roundtrip failed", {
      diagnosticsKey,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (defaultWriteOk) {
      let deleteOk = false;
      try {
        deleteOk = await storage.delete(diagnosticsKey);
      } catch (error) {
        LogEngine.error("Storage diagnostics: delete test failed", {
          diagnosticsKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      LogEngine.info("Storage diagnostics: delete test", { diagnosticsKey, deleteOk });
    }
  }

  for (const layerTest of layerTests) {
    const layerKey = `${diagnosticsKey}:${layerTest.label}`;
    const layerWriteOptions = layerTest.layer
      ? { layer: layerTest.layer as never, ttl: 60 }
      : diagnosticsWriteOptions;
    let layerWriteOk = false;
    try {
      layerWriteOk = await storage.set(
        layerKey,
        {
          ...diagnosticsValue,
          layer: layerTest.label,
        },
        layerWriteOptions,
      );

      const readValue = await storage.get<typeof diagnosticsValue & { layer: string }>(
        layerKey,
        layerTest.readOptions ?? {},
      );

      LogEngine.info("Storage diagnostics: layer roundtrip", {
        layer: layerTest.label,
        layerKey,
        writeOk: layerWriteOk,
        readOk: readValue !== null,
        readValue,
      });
    } catch (error) {
      LogEngine.error("Storage diagnostics: layer roundtrip failed", {
        layer: layerTest.label,
        layerKey,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (layerWriteOk) {
        let deleteOk = false;
        try {
          deleteOk = await storage.delete(
            layerKey,
            layerTest.layer ? { layer: layerTest.layer as never } : {},
          );
        } catch (error) {
          LogEngine.error("Storage diagnostics: layer cleanup failed", {
            layer: layerTest.label,
            layerKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        LogEngine.info("Storage diagnostics: layer cleanup", {
          layer: layerTest.label,
          layerKey,
          deleteOk,
        });
      }
    }
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
  initializeMediaProxyStore(storage);
  LogEngine.info("Storage: Nuvex initialized");
  logStorageDiagnostics(storage).catch((err) => {
    LogEngine.error("Storage diagnostics failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

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
    res.json({
      status: "ok",
      version: BOT_VERSION,
      storage: health,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/webhooks/twilio", twilioWebhookRouter);
  app.use("/media", mediaProxyRouter);

  app.listen(config.port, () => {
    LogEngine.log(`Unthread WhatsApp Bot v${BOT_VERSION} running on port ${config.port}`);
    LogEngine.info("Twilio webhook:   POST /webhooks/twilio");
    LogEngine.info("Media proxy:      GET  /media/:token");
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
