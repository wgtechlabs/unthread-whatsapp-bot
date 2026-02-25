import type { NuvexClient } from "@wgtechlabs/nuvex";
import type { CustomerMapping } from "../types";
import * as unthread from "./unthread";

// Nuvex namespaces
const NS_PHONE = "wa:phone";  // phone -> CustomerMapping
const NS_CONVO = "wa:convo";  // conversationId -> phone (reverse index)

let _storage: NuvexClient;

export function setStorage(client: NuvexClient): void {
  _storage = client;
}

function storage(): NuvexClient {
  if (!_storage) throw new Error("Storage not initialized. Call setStorage() first.");
  return _storage;
}

// Resolve or create an Unthread customer from a WhatsApp message
export async function resolveCustomer(
  phone: string,
  profileName: string | null,
): Promise<CustomerMapping> {
  // Check storage first (memory -> Redis -> Postgres via Nuvex)
  const existing = await storage().getNamespaced(NS_PHONE, phone) as CustomerMapping | null;
  if (existing) {
    return existing;
  }

  // Try to find existing customer in Unthread by dummy email
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
    await storage().setNamespaced(NS_PHONE, phone, mapping);
    return mapping;
  }

  // Create new customer in Unthread
  const name = profileName || phone;
  const customer = await unthread.createCustomer(phone, name);

  const mapping: CustomerMapping = {
    phone,
    customerId: customer.id,
    conversationId: null,
    profileName,
  };
  await storage().setNamespaced(NS_PHONE, phone, mapping);
  return mapping;
}

// Get or create an active conversation for a customer
export async function resolveConversation(
  mapping: CustomerMapping,
  initialMessage: string,
  onBehalfOf: { email: string; name: string },
): Promise<{ conversationId: string; isNew: boolean }> {
  if (mapping.conversationId) {
    // Check if conversation is still open
    try {
      const convo = await unthread.getConversation(mapping.conversationId);
      if (convo.status === "open" || convo.status === "waiting") {
        return { conversationId: mapping.conversationId, isNew: false };
      }
    } catch {
      // Conversation not found or closed, fall through to create new one
    }
  }

  // Create a new conversation with the initial message
  const title = `WhatsApp: ${mapping.profileName || mapping.phone}`;
  const convo = await unthread.createConversation(mapping.customerId, title, initialMessage, onBehalfOf);

  // Persist updated mapping and reverse index
  mapping.conversationId = convo.id;
  await storage().setNamespaced(NS_PHONE, mapping.phone, mapping);
  await storage().setNamespaced(NS_CONVO, convo.id, mapping.phone);

  return { conversationId: convo.id, isNew: true };
}

// Look up phone number by conversation ID (for outbound agent replies)
export async function findPhoneByConversationId(
  conversationId: string,
): Promise<string | null> {
  return await storage().getNamespaced(NS_CONVO, conversationId) as string | null;
}
