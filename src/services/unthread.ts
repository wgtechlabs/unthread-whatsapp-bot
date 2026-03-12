import { LogEngine } from "@wgtechlabs/log-engine";
import { config } from "../config";
import type {
  UnthreadCustomer,
  UnthreadConversation,
  UnthreadMessage,
} from "../types";

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": config.unthread.apiKey,
};

function isReusableConversationStatus(status: string | undefined): boolean {
  return status === "open"
    || status === "waiting"
    || status === "on_hold"
    || status === "on-hold"
    || status === "in_progress";
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.unthread.apiUrl}${path}`;

  LogEngine.debug(`Unthread API ${method} ${path}`, { payload: body });

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unthread API ${method} ${path} failed (${res.status}): ${text}`);
  }

  const data = await res.json() as T;
  LogEngine.debug(`Unthread API ${method} ${path} response OK`);
  return data;
}

// Search for existing customer by email
export async function findCustomerByEmail(
  email: string,
): Promise<UnthreadCustomer | null> {
  try {
    const customers = await request<UnthreadCustomer[]>(
      "GET",
      `/customers?email=${encodeURIComponent(email)}`,
    );
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    LogEngine.debug("Failed to find customer by email", {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Create a new customer in Unthread
// Following the pattern: {phone@whatsapp.user} as dummy email
export async function createCustomer(
  phone: string,
  name: string,
): Promise<UnthreadCustomer> {
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const email = `${cleanPhone}@whatsapp.user`;

  return request<UnthreadCustomer>("POST", "/customers", {
    name: `[WhatsApp] ${name}`,
    email,
    phoneNumber: phone,
  });
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
  return request<UnthreadMessage>(
    "POST",
    `/conversations/${conversationId}/messages`,
    {
      body: {
        type: "markdown",
        value: message,
      },
      onBehalfOf: {
        email: onBehalfOf.email,
        name: onBehalfOf.name,
      },
    },
  );
}

// Get a conversation by ID
export async function getConversation(
  conversationId: string,
): Promise<UnthreadConversation> {
  return request<UnthreadConversation>(
    "GET",
    `/conversations/${conversationId}`,
  );
}

// Get customer by ID
export async function getCustomer(
  customerId: string,
): Promise<UnthreadCustomer> {
  return request<UnthreadCustomer>("GET", `/customers/${customerId}`);
}

// Find the most recent open/waiting conversation for a customer
export async function findOpenConversationByCustomer(
  customerId: string,
): Promise<UnthreadConversation | null> {
  try {
    const conversations = await request<UnthreadConversation[]>(
      "GET",
      `/conversations?customerId=${encodeURIComponent(customerId)}`,
    );

    // Reuse any active customer-facing conversation status.
    const open = conversations.find(
      (c) => isReusableConversationStatus(c.status),
    );

    return open ?? null;
  } catch (err) {
    LogEngine.debug("Failed to find open conversation for customer", {
      customerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
