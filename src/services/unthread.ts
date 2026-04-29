import { LogEngine } from "@wgtechlabs/log-engine";
import { config } from "../config";
import type {
  InboundAttachment,
  UnthreadConversation,
  UnthreadCustomer,
  UnthreadMessage,
} from "../types";
import { isReusableConversationStatus } from "../types";
import { buildWhatsAppFallbackEmail } from "./whatsapp-identity";

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": config.unthread.apiKey,
};

export class UnthreadApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(method: string, path: string, status: number, responseBody: string) {
    super(`Unthread API ${method} ${path} failed (${status}): ${responseBody}`);
    this.name = "UnthreadApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export function isUnthreadApiNotFoundError(error: unknown): error is UnthreadApiError {
  return error instanceof UnthreadApiError && error.status === 404;
}

function isFallbackLookupError(error: unknown): error is UnthreadApiError {
  return error instanceof UnthreadApiError && (error.status === 400 || error.status === 404);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.unthread.apiUrl}${path}`;

  LogEngine.debug(`Unthread API ${method} ${path}`, { payload: body });

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new UnthreadApiError(method, path, res.status, text);
  }

  const data = (await res.json()) as T;
  LogEngine.debug(`Unthread API ${method} ${path} response OK`);
  return data;
}

// Search for existing customer by email
export async function findCustomerByEmail(email: string): Promise<UnthreadCustomer | null> {
  const customers = await request<UnthreadCustomer[]>(
    "GET",
    `/customers?email=${encodeURIComponent(email)}`,
  );
  return customers.length > 0 ? customers[0] : null;
}

export async function findCustomerByPhone(phone: string): Promise<UnthreadCustomer | null> {
  const queryPaths = [
    `/customers?phoneNumber=${encodeURIComponent(phone)}`,
    `/customers?phone=${encodeURIComponent(phone)}`,
  ];

  for (const path of queryPaths) {
    try {
      const customers = await request<UnthreadCustomer[]>("GET", path);
      const exactMatch = customers.find((customer) => customer.phoneNumber === phone);
      if (exactMatch) {
        return exactMatch;
      }
    } catch (err) {
      if (isFallbackLookupError(err)) {
        LogEngine.debug("Phone lookup path unavailable, trying fallback", {
          phone,
          path,
          status: err.status,
        });
        continue;
      }

      LogEngine.error("Failed to find customer by phone", {
        phone,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return null;
}

// Create a new customer in Unthread using the resolved customer identity and email.
export async function createCustomer(
  phone: string,
  name: string,
  email: string,
): Promise<UnthreadCustomer> {
  return request<UnthreadCustomer>("POST", "/customers", {
    name: `[WhatsApp] ${name}`,
    email,
    phoneNumber: phone,
  });
}

export function resolveCustomerEmail(email: string | null | undefined, phone: string): string {
  const normalizedEmail = typeof email === "string" ? email.trim() : "";
  if (normalizedEmail) {
    return normalizedEmail;
  }

  const fallbackEmail = buildWhatsAppFallbackEmail(phone);
  if (!fallbackEmail) {
    throw new Error("Unable to resolve customer email without a valid WhatsApp phone number");
  }

  return fallbackEmail;
}

// Create a new conversation (ticket) for a customer
export async function createConversation(
  customerId: string,
  title: string,
  initialMessage: string,
  onBehalfOf: { email: string; name: string },
): Promise<UnthreadConversation> {
  return request<UnthreadConversation>("POST", "/conversations", {
    type: "slack",
    title,
    markdown: initialMessage,
    status: "open",
    channelId: config.unthread.channelId,
    customerId,
    onBehalfOf: {
      email: onBehalfOf.email,
      name: onBehalfOf.name,
    },
  });
}

// Add a message to an existing conversation on behalf of the customer
export async function addMessage(
  conversationId: string,
  message: string,
  onBehalfOf: { email: string; name: string },
): Promise<UnthreadMessage> {
  return request<UnthreadMessage>("POST", `/conversations/${conversationId}/messages`, {
    body: {
      type: "markdown",
      value: message,
    },
    onBehalfOf: {
      email: onBehalfOf.email,
      name: onBehalfOf.name,
    },
  });
}

// Add a message with file attachments to an existing conversation.
// Uses multipart FormData with json and attachments fields as expected by the Unthread API.
export async function addMessageWithAttachments(
  conversationId: string,
  message: string,
  onBehalfOf: { email: string; name: string },
  attachments: InboundAttachment[],
): Promise<UnthreadMessage> {
  const url = `${config.unthread.apiUrl}/conversations/${conversationId}/messages`;

  LogEngine.debug("Unthread API POST multipart", {
    path: `/conversations/${conversationId}/messages`,
    attachmentCount: attachments.length,
  });

  const form = new FormData();
  form.append(
    "json",
    JSON.stringify({
      body: { type: "markdown", value: message },
      onBehalfOf: { email: onBehalfOf.email, name: onBehalfOf.name },
    }),
  );

  for (const attachment of attachments) {
    // Convert Buffer to a plain ArrayBuffer to satisfy the Blob constructor's type constraints.
    const arrayBuffer = attachment.buffer.buffer.slice(
      attachment.buffer.byteOffset,
      attachment.buffer.byteOffset + attachment.buffer.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: attachment.mimeType });
    form.append("attachments", blob, attachment.fileName);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": config.unthread.apiKey },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new UnthreadApiError(
      "POST",
      `/conversations/${conversationId}/messages`,
      res.status,
      text,
    );
  }

  const data = (await res.json()) as UnthreadMessage;
  LogEngine.debug("Unthread API POST multipart response OK");
  return data;
}

// Get a conversation by ID
export async function getConversation(conversationId: string): Promise<UnthreadConversation> {
  return request<UnthreadConversation>("GET", `/conversations/${conversationId}`);
}

// Get customer by ID
export async function getCustomer(customerId: string): Promise<UnthreadCustomer> {
  return request<UnthreadCustomer>("GET", `/customers/${customerId}`);
}

// Find the most recent open/waiting conversation for a customer
export async function findOpenConversationByCustomer(
  customerId: string,
): Promise<UnthreadConversation | null> {
  let conversations: UnthreadConversation[];
  const path = `/conversations?customerId=${encodeURIComponent(customerId)}`;

  try {
    conversations = await request<UnthreadConversation[]>("GET", path);
  } catch (error) {
    if (isUnthreadApiNotFoundError(error)) {
      LogEngine.debug("No conversations found for customer", {
        customerId,
        path,
      });
      return null;
    }

    throw error;
  }

  // Reuse any active customer-facing conversation status.
  const open = conversations.find((c) => isReusableConversationStatus(c.status));

  return open ?? null;
}
