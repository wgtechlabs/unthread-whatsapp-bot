import type { CustomerMapping } from "../types";
import * as unthread from "./unthread";

// In-memory store for phone -> customer mappings
// TODO: Replace with persistent storage (Redis/MongoDB) for production
const store = new Map<string, CustomerMapping>();

// Resolve or create an Unthread customer from a WhatsApp message
export async function resolveCustomer(
  phone: string,
  profileName: string | null,
): Promise<CustomerMapping> {
  // Check in-memory cache first
  const existing = store.get(phone);
  if (existing) {
    return existing;
  }

  // Try to find existing customer by dummy email
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const dummyEmail = `${cleanPhone}@whatsapp.user`;
  const existingCustomer = await unthread.findCustomerByEmail(dummyEmail);

  if (existingCustomer) {
    const mapping: CustomerMapping = {
      phone,
      customerId: existingCustomer.id,
      conversationId: null,
      profileName,
    };
    store.set(phone, mapping);
    return mapping;
  }

  // Create new customer
  const name = profileName || phone;
  const customer = await unthread.createCustomer(phone, name);

  const mapping: CustomerMapping = {
    phone,
    customerId: customer.id,
    conversationId: null,
    profileName,
  };
  store.set(phone, mapping);
  return mapping;
}

// Get or create an active conversation for a customer
export async function resolveConversation(
  mapping: CustomerMapping,
): Promise<string> {
  if (mapping.conversationId) {
    // Check if conversation is still open
    try {
      const convo = await unthread.getConversation(mapping.conversationId);
      if (convo.status === "open" || convo.status === "waiting") {
        return mapping.conversationId;
      }
    } catch {
      // Conversation not found or closed, create new one
    }
  }

  // Create a new conversation
  const title = `WhatsApp: ${mapping.profileName || mapping.phone}`;
  const convo = await unthread.createConversation(mapping.customerId, title);

  // Update mapping
  mapping.conversationId = convo.id;
  store.set(mapping.phone, mapping);

  return convo.id;
}

// Look up phone number by customer ID (for outbound messages)
export function findPhoneByCustomerId(customerId: string): string | null {
  for (const mapping of store.values()) {
    if (mapping.customerId === customerId) {
      return mapping.phone;
    }
  }
  return null;
}

// Look up phone number by conversation ID (for outbound messages)
export function findPhoneByConversationId(
  conversationId: string,
): string | null {
  for (const mapping of store.values()) {
    if (mapping.conversationId === conversationId) {
      return mapping.phone;
    }
  }
  return null;
}
