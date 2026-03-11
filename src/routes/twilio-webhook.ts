import { Router } from "express";
import type { Request, Response } from "express";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { TwilioIncomingMessage } from "../types";
import { extractPhone } from "../services/twilio";
import { resolveCustomer, resolveConversation } from "../services/customer-store";
import * as unthread from "../services/unthread";
import { sendTicketCreatedMessage, resolveTicketNumber } from "../services/system-messages";

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
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const dummyEmail = `${cleanPhone}@whatsapp.user`;
    const senderName = profileName || phone;
    const onBehalfOf = { email: dummyEmail, name: senderName };

    const { conversationId, isNew, friendlyId } = await resolveConversation(customer, body, onBehalfOf);
    LogEngine.debug("Conversation resolved", { conversationId, isNew });

    // 3. If conversation already existed, add message separately
    if (!isNew) {
      await unthread.addMessage(conversationId, body, onBehalfOf);
    }

    LogEngine.info("Message forwarded to Unthread", { conversationId });

    // Respond with empty TwiML first to close the Twilio session.
    // System messages must be sent AFTER the response so the REST API call
    // doesn't conflict with the active webhook session.
    res.type("text/xml").send("<Response></Response>");

    // 4. If new ticket was created, send ticket confirmation to customer
    if (isNew) {
      const ticketNumber = resolveTicketNumber(friendlyId, conversationId);
      LogEngine.debug("Sending ticket created notification", { conversationId, phone, ticketNumber });

      sendTicketCreatedMessage(phone, ticketNumber).catch((err) => {
        LogEngine.warn("Failed to send ticket created notification", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    LogEngine.error("Error processing incoming WhatsApp message", { error: errMsg, stack: errStack });

    if (!res.headersSent) {
      res.type("text/xml").send("<Response></Response>");
    }
  }
});
