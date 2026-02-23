import { Router } from "express";
import type { Request, Response } from "express";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { UnthreadWebhookEvent } from "../types";
import { processUnthreadOutboundEvent } from "../services/unthread-outbound";

export const unthreadWebhookRouter = Router();

// POST /webhooks/unthread
// Receives webhook events from Unthread (agent replies -> send to WhatsApp)
unthreadWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const event = req.body as UnthreadWebhookEvent;

    LogEngine.debug("Unthread webhook event received", { type: event.type });

    // Only handle agent/internal messages that need to go back to WhatsApp
    await processUnthreadOutboundEvent(event);

    res.json({ ok: true });
  } catch (error) {
    LogEngine.error("Error processing Unthread webhook", { error });
    res.status(500).json({ error: "Internal server error" });
  }
});
