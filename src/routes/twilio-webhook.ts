import { Router } from "express";
import type { Request, Response } from "express";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { TwilioIncomingMessage } from "../types";
import { extractPhone } from "../services/twilio";
import { resolveCustomer, resolveConversation } from "../services/customer-store";
import * as unthread from "../services/unthread";

export const twilioWebhookRouter = Router();

// POST /webhooks/twilio
// Receives incoming WhatsApp messages from Twilio
twilioWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const message = req.body as TwilioIncomingMessage;
    const phone = extractPhone(message.From);
    const body = message.Body;
    const profileName = message.ProfileName || null;

    LogEngine.info(`Incoming WhatsApp message from ${phone}`, { profileName, body });

    // 1. Resolve or create customer in Unthread
    const customer = await resolveCustomer(phone, profileName);
    LogEngine.debug("Customer resolved", { customerId: customer.customerId, phone });

    // 2. Get or create active conversation
    const conversationId = await resolveConversation(customer);
    LogEngine.debug("Conversation resolved", { conversationId });

    // 3. Add message to conversation on behalf of the customer
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const dummyEmail = `${cleanPhone}@whatsapp.user`;
    const senderName = profileName || phone;

    await unthread.addMessage(conversationId, body, {
      email: dummyEmail,
      name: senderName,
    });

    LogEngine.info("Message forwarded to Unthread", { conversationId });

    // Respond with empty TwiML (no auto-reply, let Unthread handle it)
    res.type("text/xml").send("<Response></Response>");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    LogEngine.error("Error processing incoming WhatsApp message", { error: errMsg, stack: errStack });
    res.type("text/xml").send("<Response></Response>");
  }
});
