import { Router } from "express";
import type { Request, Response } from "express";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { TwilioIncomingMessage } from "../types";
import { extractPhone } from "../services/twilio";
import { resolveCustomer, resolveConversation } from "../services/customer-store";
import * as unthread from "../services/unthread";
import { buildTicketCreatedMessage, resolveTicketNumber } from "../services/system-messages";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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

    // Respond with TwiML — include ticket creation notification inline for new tickets.
    // Using TwiML <Message> is more reliable than a separate REST API call since it's
    // delivered as a direct session reply with no additional auth or format concerns.
    const ticketNumber = resolveTicketNumber(friendlyId, conversationId);
    if (isNew) {
      const notif = buildTicketCreatedMessage(ticketNumber);
      res.type("text/xml").send(`<Response><Message><Body>${escapeXml(notif)}</Body></Message></Response>`);
    } else {
      res.type("text/xml").send("<Response></Response>");
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    LogEngine.error("Error processing incoming WhatsApp message", { error: errMsg, stack: errStack });
    res.type("text/xml").send("<Response></Response>");
  }
});
