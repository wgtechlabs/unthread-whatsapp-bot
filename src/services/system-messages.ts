import { LogEngine } from "@wgtechlabs/log-engine";
import { sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";

function sanitizeTicketNumber(value: string): string {
  return value.replace(/[^a-zA-Z0-9\-_]/g, "");
}

export function resolveTicketNumber(friendlyId?: string | null, conversationId?: string): string {
  const raw = friendlyId || conversationId?.slice(0, 8) || "unknown";
  return sanitizeTicketNumber(raw);
}

const templates = {
  ticket_created: [
    "*Support Ticket Created*",
    "",
    "Ticket #{{ticketNumber}}",
    "Your message has been received and a support ticket has been created. An agent will respond shortly.",
    "",
    "Reply to this chat to add more details to your ticket.",
  ].join("\n"),

  ticket_closed: [
    "*Ticket Closed*",
    "",
    "Ticket #{{ticketNumber}} has been closed.",
    "If you need further assistance, simply send a new message to start a new ticket.",
  ].join("\n"),

  ticket_on_hold: [
    "*Ticket On Hold*",
    "",
    "Ticket #{{ticketNumber}} has been placed on hold.",
    "If you have additional information, reply here and your ticket will be resumed.",
  ].join("\n"),

  ticket_resumed: [
    "*Ticket Resumed*",
    "",
    "Ticket #{{ticketNumber}} is now active again. An agent will follow up shortly.",
  ].join("\n"),

} as const;

type TemplateKey = keyof typeof templates;

function renderTemplate(key: TemplateKey, variables: Record<string, string>): string {
  let content: string = templates[key];
  for (const [name, value] of Object.entries(variables)) {
    content = content.split(`{{${name}}}`).join(value);
  }
  return content;
}

async function sendSystemMessage(phone: string, message: string): Promise<boolean> {
  try {
    await sendWhatsAppMessage(toWhatsAppFormat(phone), message);
    LogEngine.info("System message sent", { phone });
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    const msg = (err as { message?: string }).message ?? "Unknown error";
    LogEngine.error("Failed to send system message", { phone, twilioCode: code, error: msg });
    return false;
  }
}

export async function sendTicketCreatedMessage(
  phone: string,
  ticketNumber: string,
): Promise<boolean> {
  const safe = sanitizeTicketNumber(ticketNumber);
  const message = renderTemplate("ticket_created", { ticketNumber: safe });
  return sendSystemMessage(phone, message);
}

export async function sendStatusChangeMessage(
  phone: string,
  ticketNumber: string,
  newStatus: string,
  previousStatus?: string,
): Promise<boolean> {
  // Caller is expected to normalize, but we lowercase defensively since this is exported
  const status = newStatus.toLowerCase();
  const prevStatus = previousStatus?.toLowerCase() ?? "";
  const safe = sanitizeTicketNumber(ticketNumber);

  let templateKey: TemplateKey;

  switch (status) {
    case "closed":
    case "resolved":
      templateKey = "ticket_closed";
      break;
    case "on_hold":
    case "on-hold":
    case "waiting":
      templateKey = "ticket_on_hold";
      break;
    case "open":
    case "in_progress":
      // Distinguish "resumed from hold" vs generic reopen
      if (prevStatus === "on_hold" || prevStatus === "on-hold" || prevStatus === "waiting") {
        templateKey = "ticket_resumed";
      } else {
        // Status changed to open but not from on_hold — no system message needed
        // (e.g., initial open is handled by sendTicketCreatedMessage)
        LogEngine.debug("Skipping system message for status change to open (not from hold)", {
          newStatus,
          previousStatus,
        });
        return false;
      }
      break;
    default:
      LogEngine.debug("Unknown status for system message, skipping", { newStatus });
      return false;
  }

  const message = renderTemplate(templateKey, { ticketNumber: safe });
  return sendSystemMessage(phone, message);
}
