import express from "express";
import { NuvexClient } from "@wgtechlabs/nuvex";
import type { NuvexConfig } from "@wgtechlabs/nuvex";
import { LogEngine } from "@wgtechlabs/log-engine";
import { config } from "./config";
import { setStorage } from "./services/customer-store";
import { twilioWebhookRouter } from "./routes/twilio-webhook";
import { unthreadWebhookRouter } from "./routes/unthread-webhook";

async function bootstrap() {
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

  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const health = await storage.healthCheck();
    res.json({ status: "ok", storage: health, timestamp: new Date().toISOString() });
  });

  app.use("/webhooks/twilio", twilioWebhookRouter);
  app.use("/webhooks/unthread", unthreadWebhookRouter);

  app.listen(config.port, () => {
    LogEngine.log(`Unthread WhatsApp Bot running on port ${config.port}`);
    LogEngine.info("Twilio webhook:   POST /webhooks/twilio");
    LogEngine.info("Unthread webhook: POST /webhooks/unthread");
    LogEngine.info("Health check:     GET  /health");
  });
}

bootstrap().catch((err) => {
  LogEngine.error("Failed to start server", { error: err });
  process.exit(1);
});
