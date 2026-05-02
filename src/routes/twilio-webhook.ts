import { LogEngine } from "@wgtechlabs/log-engine";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { config } from "../config";
import {
  fileNameFromMimeType,
  sanitizeFileName,
  validateAttachmentCount,
  validateAttachmentSize,
  validateMimeType,
} from "../services/attachment-validator";
import {
  findExistingCustomer,
  resolveConversation,
  resolveCustomer,
} from "../services/customer-store";
import { recoverFromEmailPromptFailure } from "../services/email-prompt-recovery";
import {
  resolveTicketNumber,
  sendEmailPromptMessage,
  sendTicketCreatedMessage,
} from "../services/system-messages";
import { downloadTwilioMedia, extractPhone, validateTwilioSignature } from "../services/twilio";
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
import type { InboundAttachment, PendingAttachmentMeta, TwilioIncomingMessage } from "../types";

// Fallback message body for attachment-only messages (no text provided by user)
const ATTACHMENT_FALLBACK_BODY = "📎 File attachment";

// Marker body used when uploading attachments for a brand-new conversation that
// already has the customer text as its opening message. Keeps attachment messages
// visually distinct without repeating the full user text.
const ATTACHMENT_MARKER_BODY = "📎 Attachment";

// Parse the NumMedia field from a Twilio message into a non-negative integer.
// Returns 0 for missing, non-finite, or negative values.
export function parseNumMedia(message: TwilioIncomingMessage): number {
  const parsed = parseInt(message.NumMedia ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

// Extract raw media URL/contentType pairs from a Twilio message without downloading.
// Iterates up to 10 items and skips entries where the URL is absent.
export function extractMediaItems(
  message: TwilioIncomingMessage,
): Array<{ url: string; contentType: string }> {
  const numMedia = parseNumMedia(message);
  const items: Array<{ url: string; contentType: string }> = [];

  for (let index = 0; index < Math.min(numMedia, 10); index++) {
    const urlKey = `MediaUrl${index}` as keyof TwilioIncomingMessage;
    const typeKey = `MediaContentType${index}` as keyof TwilioIncomingMessage;

    const url = message[urlKey] as string | undefined;
    const contentType = (message[typeKey] as string | undefined) ?? "application/octet-stream";

    if (url) {
      items.push({ url, contentType });
    }
  }

  return items;
}

// Parse inbound Twilio media fields and return an array of attachment objects.
// Returns an empty array when NumMedia is 0 or media fields are absent.
async function downloadInboundAttachments(
  message: TwilioIncomingMessage,
): Promise<InboundAttachment[]> {
  const numMedia = parseNumMedia(message);
  if (numMedia <= 0) {
    return [];
  }

  const countCheck = validateAttachmentCount(numMedia);
  if (!countCheck.valid) {
    LogEngine.warn("Inbound media count exceeds limit, capping to max allowed", {
      numMedia,
      reason: countCheck.reason,
    });
  }

  const maxToProcess = Math.min(numMedia, 10);
  const attachments: InboundAttachment[] = [];

  for (let index = 0; index < maxToProcess; index++) {
    const mediaUrlKey = `MediaUrl${index}` as keyof TwilioIncomingMessage;
    const mediaTypeKey = `MediaContentType${index}` as keyof TwilioIncomingMessage;

    const rawMediaUrl = message[mediaUrlKey] as string | undefined;
    const rawContentType = message[mediaTypeKey] as string | undefined;

    if (!rawMediaUrl) {
      LogEngine.warn("Expected Twilio media URL not present", { index, numMedia });
      continue;
    }

    const mimeType =
      rawContentType?.split(";")[0].trim().toLowerCase() ?? "application/octet-stream";

    const mimeCheck = validateMimeType(mimeType);
    if (!mimeCheck.valid) {
      LogEngine.warn("Skipping inbound attachment with unsupported MIME type", {
        index,
        mimeType,
        reason: mimeCheck.reason,
      });
      continue;
    }

    try {
      const { buffer, mimeType: detectedMimeType } = await downloadTwilioMedia(rawMediaUrl);
      // Re-validate the content-type reported by the response against the allowlist.
      // Twilio CDN may return a different type (e.g. application/octet-stream) from the
      // webhook field. Fall back to the pre-validated Twilio-reported type when the
      // detected type is absent or not on the allowlist.
      const finalMimeType =
        detectedMimeType && validateMimeType(detectedMimeType).valid ? detectedMimeType : mimeType;
      const sizeCheck = validateAttachmentSize(
        finalMimeType,
        buffer.length,
        config.media.maxAttachmentSizeBytes,
      );

      if (!sizeCheck.valid) {
        LogEngine.warn("Skipping inbound attachment that failed size validation", {
          index,
          sizeBytes: buffer.length,
          mimeType: finalMimeType,
          reason: sizeCheck.reason,
        });
        continue;
      }

      // Generate a unique filename per attachment to avoid collisions when multiple
      // items of the same MIME type arrive in one message.
      const baseName = fileNameFromMimeType(finalMimeType);
      const dotIdx = baseName.lastIndexOf(".");
      const uniqueName =
        index === 0
          ? baseName
          : dotIdx >= 0
            ? `${baseName.slice(0, dotIdx)}_${index}${baseName.slice(dotIdx)}`
            : `${baseName}_${index}`;
      const fileName = sanitizeFileName(uniqueName);
      attachments.push({
        buffer,
        mimeType: finalMimeType,
        fileName,
        sizeBytes: buffer.length,
        originalMediaUrl: rawMediaUrl,
      });
    } catch (error) {
      LogEngine.error("Failed to download inbound Twilio media", {
        index,
        mimeType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return attachments;
}

// Upload any inbound attachments to an existing Unthread conversation.
// When the conversation is newly created (isNew=true) and the user sent text, the
// text is already in the opening message — a short marker body is used to avoid duplication.
async function uploadAttachmentsToConversation(
  conversationId: string,
  attachments: InboundAttachment[],
  onBehalfOf: { email: string; name: string },
  options: { isNew: boolean; hadText: boolean },
): Promise<void> {
  if (attachments.length === 0) return;

  const messageBody =
    options.isNew && options.hadText ? ATTACHMENT_MARKER_BODY : ATTACHMENT_FALLBACK_BODY;

  try {
    await unthread.addMessageWithAttachments(conversationId, messageBody, onBehalfOf, attachments);
    LogEngine.info("Inbound attachments uploaded to Unthread", {
      conversationId,
      attachmentCount: attachments.length,
    });
  } catch (error) {
    LogEngine.error("Failed to upload inbound attachments to Unthread", {
      conversationId,
      attachmentCount: attachments.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function forwardCustomerMessage(
  phone: string,
  profileName: string | null,
  messageBody: string,
  email: string,
  attachments: InboundAttachment[] = [],
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

  // Use a fallback body so attachment-only messages still open a valid conversation
  const bodyToUse = messageBody || ATTACHMENT_FALLBACK_BODY;
  const result = await resolveConversation(customer, bodyToUse, onBehalfOf);
  LogEngine.debug("Conversation resolved", {
    conversationId: result.conversationId,
    isNew: result.isNew,
  });

  if (!result.isNew) {
    if (attachments.length > 0) {
      await unthread.addMessageWithAttachments(
        result.conversationId,
        bodyToUse,
        onBehalfOf,
        attachments,
      );
    } else {
      await unthread.addMessage(result.conversationId, bodyToUse, onBehalfOf);
    }
  } else if (attachments.length > 0) {
    // Conversation was just created with the initial body — upload attachments as a follow-up.
    await uploadAttachmentsToConversation(result.conversationId, attachments, onBehalfOf, {
      isNew: true,
      hadText: Boolean(messageBody),
    });
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
  attachments: InboundAttachment[] = [],
): Promise<void> {
  const fallbackEmail = unthread.resolveCustomerEmail(null, phone);
  const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
    phone,
    profileName,
    messageBody,
    fallbackEmail,
    attachments,
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

async function recoverPromptFailureWithFallback(
  phone: string,
  profileName: string | null,
  initialMessage: string,
  stage: "initial" | "retry",
  attachments: InboundAttachment[] = [],
  error?: unknown,
): Promise<void> {
  await recoverFromEmailPromptFailure({
    phone,
    profileName,
    initialMessage,
    stage,
    error,
    clearPendingState: async () => clearEmailCollectionState(phone),
    forwardFallback: async () =>
      forwardWithFallbackEmail(phone, profileName, initialMessage, attachments),
  });
}

// Re-download pending attachment metadata after email is captured and return
// InboundAttachment objects ready for upload. Failures are logged and skipped gracefully.
async function redownloadPendingAttachments(
  pending: PendingAttachmentMeta[],
): Promise<InboundAttachment[]> {
  const attachments: InboundAttachment[] = [];

  for (const meta of pending) {
    try {
      const { buffer, mimeType: detectedMimeType } = await downloadTwilioMedia(meta.mediaUrl);
      // Re-validate the detected content-type against the allowlist, just as the
      // initial download path does. Fall back to the stored type when the detected
      // type is absent or not on the allowlist.
      const finalMimeType =
        detectedMimeType && validateMimeType(detectedMimeType).valid
          ? detectedMimeType
          : meta.contentType;
      const sizeCheck = validateAttachmentSize(
        finalMimeType,
        buffer.length,
        config.media.maxAttachmentSizeBytes,
      );

      if (!sizeCheck.valid) {
        LogEngine.warn("Skipping re-downloaded attachment that failed size validation", {
          fileName: meta.fileName,
          reason: sizeCheck.reason,
        });
        continue;
      }

      attachments.push({
        buffer,
        mimeType: finalMimeType,
        fileName: sanitizeFileName(meta.fileName),
        sizeBytes: buffer.length,
        originalMediaUrl: meta.mediaUrl,
      });
    } catch (error) {
      LogEngine.error("Failed to re-download pending attachment after email capture", {
        fileName: meta.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return attachments;
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
    const body = message.Body ?? "";
    const profileName = message.ProfileName || null;
    const numMedia = parseInt(message.NumMedia ?? "0", 10);

    LogEngine.info(`Incoming WhatsApp message from ${phone}`, {
      profileName,
      hasText: Boolean(body),
      numMedia: Number.isFinite(numMedia) ? numMedia : 0,
    });

    // Respond with empty TwiML first to close the Twilio session.
    // System messages must be sent AFTER the response so the REST API call
    // doesn't conflict with the active webhook session.
    sendEmptyTwiML(res);

    // Download any attached media now — before branching into email-collection logic
    const inboundAttachments = await downloadInboundAttachments(message);

    const pendingEmailCollection = await getEmailCollectionState(phone);
    if (pendingEmailCollection) {
      if (isCancelMessage(body)) {
        LogEngine.info("Email collection cancelled, continuing with fallback email", { phone });

        const fallbackEmail = unthread.resolveCustomerEmail(null, phone);
        const pendingAttachments = await redownloadPendingAttachments(
          pendingEmailCollection.pendingAttachments ?? [],
        );
        // Merge any attachments from this cancel message too
        const allAttachments = [...pendingAttachments, ...inboundAttachments];

        const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
          phone,
          profileName ?? pendingEmailCollection.profileName,
          pendingEmailCollection.initialMessage,
          fallbackEmail,
          allAttachments,
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
        const retryAttachments = [
          ...(await redownloadPendingAttachments(pendingEmailCollection.pendingAttachments ?? [])),
          ...inboundAttachments,
        ];
        try {
          const promptSent = await sendEmailPromptMessage(phone, { retry: true });
          if (!promptSent) {
            await recoverPromptFailureWithFallback(
              phone,
              profileName ?? pendingEmailCollection.profileName,
              pendingEmailCollection.initialMessage,
              "retry",
              retryAttachments,
            );
          }
        } catch (error) {
          await recoverPromptFailureWithFallback(
            phone,
            profileName ?? pendingEmailCollection.profileName,
            pendingEmailCollection.initialMessage,
            "retry",
            retryAttachments,
            error,
          );
        }
        return;
      }

      LogEngine.info("Email captured for WhatsApp onboarding", { phone, email });

      const pendingAttachments = await redownloadPendingAttachments(
        pendingEmailCollection.pendingAttachments ?? [],
      );

      const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
        phone,
        profileName ?? pendingEmailCollection.profileName,
        pendingEmailCollection.initialMessage,
        email,
        pendingAttachments,
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

      // Build pending attachment metadata (URLs only, no bytes) for deferred upload.
      // Use the originalMediaUrl stored with each attachment to avoid index alignment issues
      // when some media items were skipped during validation.
      const pendingAttachmentMeta: PendingAttachmentMeta[] = inboundAttachments.map(
        (attachment) => ({
          mediaUrl: attachment.originalMediaUrl,
          contentType: attachment.mimeType,
          fileName: attachment.fileName,
        }),
      );

      try {
        await storeEmailCollectionState({
          phone,
          initialMessage: body,
          profileName,
          pendingAttachments: pendingAttachmentMeta.length > 0 ? pendingAttachmentMeta : undefined,
        });
      } catch (error) {
        LogEngine.error("Failed to persist pending WhatsApp email collection state", {
          phone,
          profileName,
          error: error instanceof Error ? error.message : String(error),
        });

        await forwardWithFallbackEmail(phone, profileName, body, inboundAttachments);
        return;
      }

      try {
        const promptSent = await sendEmailPromptMessage(phone);
        if (!promptSent) {
          await recoverPromptFailureWithFallback(
            phone,
            profileName,
            body,
            "initial",
            inboundAttachments,
          );
        }
      } catch (error) {
        await recoverPromptFailureWithFallback(
          phone,
          profileName,
          body,
          "initial",
          inboundAttachments,
          error,
        );
      }
      return;
    }

    const { conversationId, isNew, friendlyId } = await forwardCustomerMessage(
      phone,
      profileName,
      body,
      unthread.resolveCustomerEmail(existingCustomer.email, phone),
      inboundAttachments,
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
