import { LogEngine } from "@wgtechlabs/log-engine";
import { resolveStatusTemplateKey, type StatusTemplateKey } from "./system-message-status";
import { sendWhatsAppMessage, toWhatsAppFormat } from "./twilio";

function sanitizeTicketNumber(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : "";

  const sanitized = normalized.replace(/[^a-zA-Z0-9\-_]/g, "");
  return sanitized || "unknown";
}

export function resolveTicketNumber(friendlyId?: unknown, conversationId?: string): string {
  const raw = friendlyId || conversationId?.slice(0, 8) || "unknown";
  return sanitizeTicketNumber(raw);
}

const templates = {
  email_prompt: [
    "*Before we create your ticket*",
    "",
    "Please reply with your email address so our team can identify you correctly in Unthread.",
    "",
    "If you'd rather skip this step, reply with *cancel* and we'll continue without an email.",
  ].join("\n"),

  email_prompt_retry: [
    "*Email address required*",
    "",
    "That doesn't look like a valid email address.",
    "Please reply with a valid email or send *cancel* to continue without one.",
  ].join("\n"),

  ticket_created: [
    "*Support Ticket Created*",
    "",
    "Ticket #{{ticketNumber}}",
    "Your ticket has been created. We'll respond shortly.",
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

  ticket_in_progress: [
    "*Ticket In Progress*",
    "",
    "Ticket #{{ticketNumber}} is now in progress.",
  ].join("\n"),

  ticket_resumed: [
    "*Ticket Resumed*",
    "",
    "Ticket #{{ticketNumber}} is now active again. An agent will follow up shortly.",
  ].join("\n"),
} as const;

type TemplateKey = keyof typeof templates;
const ensureTemplateKey = (key: StatusTemplateKey): TemplateKey => key;

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

export function buildTicketCreatedMessage(ticketNumber: string): string {
  const safe = sanitizeTicketNumber(ticketNumber);
  return renderTemplate("ticket_created", { ticketNumber: safe });
}

export async function sendTicketCreatedMessage(
  phone: string,
  ticketNumber: string,
): Promise<boolean> {
  const message = buildTicketCreatedMessage(ticketNumber);
  return sendSystemMessage(phone, message);
}

export async function sendStatusChangeMessage(
  phone: string,
  ticketNumber: string,
  newStatus: string,
  previousStatus?: string,
): Promise<boolean> {
  const safe = sanitizeTicketNumber(ticketNumber);

  const statusTemplateKey = resolveStatusTemplateKey(newStatus, previousStatus);
  const templateKey = statusTemplateKey ? ensureTemplateKey(statusTemplateKey) : null;
  if (!templateKey) {
    if (newStatus.toLowerCase().replace(/-/g, "_") === "open") {
      LogEngine.debug("Skipping system message for status change to open (not from hold)", {
        newStatus,
        previousStatus,
      });
    } else {
      LogEngine.debug("Unknown status for system message, skipping", { newStatus });
    }
    return false;
  }

  const message = renderTemplate(templateKey, { ticketNumber: safe });
  return sendSystemMessage(phone, message);
}

export async function sendEmailPromptMessage(
  phone: string,
  options?: { retry?: boolean },
): Promise<boolean> {
  const templateKey: TemplateKey = options?.retry ? "email_prompt_retry" : "email_prompt";
  return sendSystemMessage(phone, renderTemplate(templateKey, {}));
}
