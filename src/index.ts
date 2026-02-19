import express from "express";
import { config } from "./config";
import { twilioWebhookRouter } from "./routes/twilio-webhook";
import { unthreadWebhookRouter } from "./routes/unthread-webhook";

const app = express();

// Parse URL-encoded bodies (Twilio sends form data)
app.use(express.urlencoded({ extended: false }));
// Parse JSON bodies (Unthread sends JSON)
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Twilio WhatsApp incoming messages
app.use("/webhooks/twilio", twilioWebhookRouter);

// Unthread webhook events (agent replies -> WhatsApp)
app.use("/webhooks/unthread", unthreadWebhookRouter);

app.listen(config.port, () => {
  console.log(`[server] Unthread WhatsApp Bot running on port ${config.port}`);
  console.log(`[server] Twilio webhook:   POST /webhooks/twilio`);
  console.log(`[server] Unthread webhook: POST /webhooks/unthread`);
  console.log(`[server] Health check:     GET  /health`);
});
