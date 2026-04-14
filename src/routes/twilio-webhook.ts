import { LogEngine } from "@wgtechlabs/log-engine";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { config } from "../config";
import {
  findExistingCustomer,
  resolveConversation,
  resolveCustomer,
} from "../services/customer-store";
import {
  resolveTicketNumber,
  sendEmailPromptMessage,
  sendTicketCreatedMessage,
} from "../services/system-messages";
import { extractPhone, validateTwilioSignature } from "../services/twilio";
import * as unthread from "../services/unthread";
import {
  formatWhatsAppIdentity,
  isCancelMessage,
  normalizeEmail,
} from "../services/whatsapp-identity";
import {
  clearEmailCollectionState,
  getEmailCollectionState,
  storeEmailCollectionState,
} from "../services/whatsapp-store";
import type { TwilioIncomingMessage } from "../types";

async function forwardCustomerMessage(
  phone: string,
  profileName: string | null,
  messageBody: string,
  email: string,
): Promise<{ conversationId: string; isNew: boolean; friendlyId?: string | number }> {
  const customer = await resolveCustomer(phone, profileName, email);
  LogEngine.debug("Customer resolved", {
    customerId: customer.customerId,
    phone,
    email: customer.email,
  });

  const onBehalfOf = {
    email,
    name: formatWhatsAppIdentity(profileName, phone),
  };

  const result = await resolveConversation(customer, messageBody, onBehalfOf);
  LogEngine.debug("Conversation resolved", {
    conversationId: result.conversationId,
    isNew: result.isNew,
  });

  if (!result.isNew) {
    await unthread.addMessage(result.conversationId, messageBody, onBehalfOf);
  }

  LogEngine.info("Message forwarded to Unthread", { conversationId: result.conversationId });
  return result;
}

async function clearPendingEmailCollectionOrThrow(
  phone: string,
  context: Record<string, unknown>,
): Promise<void> {
  const cleared = await clearEmailCollectionState(phone);
  if (!cleared) {
    LogEngine.error("Failed to clear pending WhatsApp email collection state", {
      phone,
      ...context,
    });
    throw new Error("Failed to clear pending WhatsApp email collection state");
  }
}

async function forwardWithFallbackEmail(
  phone: string,
  profileName: string | null,
  messageBody: string,
): Promise<void> {
  const fallbackEmail = unthread.resolveCustomerEmail(null, phone);
  const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
    phone,
    profileName,
    messageBody,
    fallbackEmail,
  );

  if (isNew) {
    const ticketNumber = resolveTicketNumber(friendlyId, conversationId);
    sendTicketCreatedMessage(phone, ticketNumber).catch((err) => {
      LogEngine.warn("Failed to send ticket created notification", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

function sendEmptyTwiML(res: Response, status = 200): void {
  res.status(status).type("text/xml").send("<Response></Response>");
}

export const twilioWebhookRouter = Router();

// Validate that the request genuinely came from Twilio by checking the
// X-Twilio-Signature header before any message processing occurs.
twilioWebhookRouter.use((req: Request, res: Response, next: NextFunction) => {
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string" || !signature) {
    LogEngine.warn("Twilio webhook rejected: missing X-Twilio-Signature header");
    sendEmptyTwiML(res, 403);
    return;
  }
  if (
    !validateTwilioSignature(
      config.twilio.webhookUrl,
      req.body as Record<string, string>,
      signature,
    )
  ) {
    LogEngine.warn("Twilio webhook rejected: invalid signature");
    sendEmptyTwiML(res, 403);
    return;
  }
  next();
});

// POST /webhooks/twilio
// Receives incoming WhatsApp messages from Twilio
twilioWebhookRouter.post("/", async (req: Request, res: Response) => {
  try {
    const message = req.body as TwilioIncomingMessage;
    const phone = extractPhone(message.From);
    const body = message.Body;
    const profileName = message.ProfileName || null;

    LogEngine.info(`Incoming WhatsApp message from ${phone}`, { profileName, body });

    // Respond with empty TwiML first to close the Twilio session.
    // System messages must be sent AFTER the response so the REST API call
    // doesn't conflict with the active webhook session.
    sendEmptyTwiML(res);

    const pendingEmailCollection = await getEmailCollectionState(phone);
    if (pendingEmailCollection) {
      if (isCancelMessage(body)) {
        LogEngine.info("Email collection cancelled, continuing with fallback email", { phone });

        const fallbackEmail = unthread.resolveCustomerEmail(null, phone);
        const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
          phone,
          profileName ?? pendingEmailCollection.profileName,
          pendingEmailCollection.initialMessage,
          fallbackEmail,
        );

        await clearPendingEmailCollectionOrThrow(phone, {
          conversationId,
          reason: "cancel",
        });

        if (isNew) {
          const ticketNumber = resolveTicketNumber(friendlyId, conversationId);
          sendTicketCreatedMessage(phone, ticketNumber).catch((err) => {
            LogEngine.warn("Failed to send ticket created notification", {
              conversationId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        return;
      }

      const email = normalizeEmail(body);
      if (!email) {
        sendEmailPromptMessage(phone, { retry: true }).catch((err) => {
          LogEngine.warn("Failed to send email retry prompt", {
            phone,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }

      LogEngine.info("Email captured for WhatsApp onboarding", { phone, email });

      const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
        phone,
        profileName ?? pendingEmailCollection.profileName,
        pendingEmailCollection.initialMessage,
        email,
      );

      await clearPendingEmailCollectionOrThrow(phone, {
        conversationId,
        reason: "email-captured",
      });

      if (isNew) {
        const ticketNumber = resolveTicketNumber(friendlyId, conversationId);
        sendTicketCreatedMessage(phone, ticketNumber).catch((err) => {
          LogEngine.warn("Failed to send ticket created notification", {
            conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }

    const existingCustomer = await findExistingCustomer(phone, profileName);
    if (!existingCustomer) {
      LogEngine.info("Starting email collection for new WhatsApp user", { phone });
      try {
        await storeEmailCollectionState({
          phone,
          initialMessage: body,
          profileName,
        });
      } catch (error) {
        LogEngine.error("Failed to persist pending WhatsApp email collection state", {
          phone,
          profileName,
          error: error instanceof Error ? error.message : String(error),
        });

        await forwardWithFallbackEmail(phone, profileName, body);
        return;
      }

      try {
        const promptSent = await sendEmailPromptMessage(phone);
        if (!promptSent) {
          const rolledBack = await clearEmailCollectionState(phone);
          LogEngine.warn(
            "Failed to send initial email prompt; rolled back pending email collection",
            {
              phone,
              profileName,
              rolledBack,
            },
          );
        }
      } catch (error) {
        try {
          const rolledBack = await clearEmailCollectionState(phone);
          if (!rolledBack) {
            LogEngine.error("Failed to roll back pending email collection after prompt failure", {
              phone,
              profileName,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } catch (rollbackError) {
          LogEngine.error("Failed to roll back pending email collection after prompt failure", {
            phone,
            profileName,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }

        LogEngine.error("Failed to send initial email prompt", {
          phone,
          profileName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
      phone,
      profileName,
      body,
      unthread.resolveCustomerEmail(existingCustomer.email, phone),
    );

    if (isNew) {
      const ticketNumber = resolveTicketNumber(friendlyId, conversationId);
      LogEngine.debug("Sending ticket created notification", {
        conversationId,
        phone,
        ticketNumber,
      });

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
    LogEngine.error("Error processing incoming WhatsApp message", {
      error: errMsg,
      stack: errStack,
    });

    if (!res.headersSent) {
      sendEmptyTwiML(res);
    }
  }
});
