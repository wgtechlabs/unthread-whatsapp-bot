import type { NuvexClient } from "@wgtechlabs/nuvex";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { CustomerMapping } from "../types";
import * as unthread from "./unthread";

// Nuvex namespaces
const NS_PHONE = "wa:phone";  // phone -> CustomerMapping
const NS_CONVO = "wa:convo";  // conversationId -> phone (reverse index)

// In-memory caches — reliable first-level lookup that survives Nuvex retrieval issues
const phoneCache = new Map<string, CustomerMapping>();
const convoCache = new Map<string, string>(); // conversationId -> phone

let _storage: NuvexClient;

export function setStorage(client: NuvexClient): void {
  _storage = client;
}

function storage(): NuvexClient {
  if (!_storage) throw new Error("Storage not initialized. Call setStorage() first.");
  return _storage;
}

// Persist mapping to both in-memory cache and Nuvex storage
async function persistMapping(mapping: CustomerMapping): Promise<void> {
  phoneCache.set(mapping.phone, { ...mapping });
  await storage().setNamespaced(NS_PHONE, mapping.phone, mapping);
  if (mapping.conversationId) {
    convoCache.set(mapping.conversationId, mapping.phone);
    await storage().setNamespaced(NS_CONVO, mapping.conversationId, mapping.phone);
  }
}

// Validate that a value from storage is a valid CustomerMapping
function isValidMapping(value: unknown): value is CustomerMapping {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.phone === "string" && typeof obj.customerId === "string";
}

// Resolve or create an Unthread customer from a WhatsApp message
export async function resolveCustomer(
  phone: string,
  profileName: string | null,
): Promise<CustomerMapping> {
  // 1. Check in-memory cache first (instant, reliable)
  const cached = phoneCache.get(phone);
  if (cached) {
    LogEngine.debug("Customer resolved from memory cache", { phone, customerId: cached.customerId });
    return cached;
  }

  // 2. Check Nuvex storage (Redis/Postgres)
  const stored = await storage().getNamespaced(NS_PHONE, phone);
  if (isValidMapping(stored)) {
    LogEngine.debug("Customer resolved from Nuvex storage", { phone, customerId: stored.customerId });
    phoneCache.set(phone, stored);
    if (stored.conversationId) {
      convoCache.set(stored.conversationId, phone);
    }
    return stored;
  }

  if (stored !== null && stored !== undefined) {
    LogEngine.warn("Nuvex returned invalid mapping data, ignoring", { phone, raw: stored });
  }

  // 3. Try to find existing customer in Unthread by dummy email
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const dummyEmail = `${cleanPhone}@whatsapp.user`;
  const existingCustomer = await unthread.findCustomerByEmail(dummyEmail);

  if (existingCustomer) {
    LogEngine.debug("Customer recovered from Unthread API", { phone, customerId: existingCustomer.id });

    // Try to recover existing open conversation context from Unthread
    const openConvo = await unthread.findOpenConversationByCustomer(existingCustomer.id);

    const mapping: CustomerMapping = {
      phone,
      customerId: existingCustomer.id,
      conversationId: openConvo?.id ?? null,
      profileName,
    };
    await persistMapping(mapping);
    return mapping;
  }

  // 4. No existing customer anywhere — create new one in Unthread
  LogEngine.debug("Creating new Unthread customer", { phone, profileName });
  const name = profileName || phone;
  const customer = await unthread.createCustomer(phone, name);

  const mapping: CustomerMapping = {
    phone,
    customerId: customer.id,
    conversationId: null,
    profileName,
  };
  await persistMapping(mapping);
  return mapping;
}

// Get or create an active conversation for a customer
export async function resolveConversation(
  mapping: CustomerMapping,
  initialMessage: string,
  onBehalfOf: { email: string; name: string },
): Promise<{ conversationId: string; isNew: boolean; friendlyId?: string }> {
  // 1. Try the stored conversationId first
  if (mapping.conversationId) {
    try {
      const convo = await unthread.getConversation(mapping.conversationId);
      if (convo.status === "open" || convo.status === "waiting") {
        LogEngine.debug("Reusing existing open conversation", {
          conversationId: mapping.conversationId,
          status: convo.status,
        });
        return { conversationId: mapping.conversationId, isNew: false };
      }
      // Conversation is closed/resolved — clear the stale reference
      LogEngine.debug("Stored conversation is no longer open", {
        conversationId: mapping.conversationId,
        status: convo.status,
      });
      mapping.conversationId = null;
    } catch (err) {
      LogEngine.warn("Failed to fetch stored conversation, will search for open ones", {
        conversationId: mapping.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      mapping.conversationId = null;
    }
  }

  // 2. Fallback: search for any open conversation for this customer
  const openConvo = await unthread.findOpenConversationByCustomer(mapping.customerId);
  if (openConvo) {
    LogEngine.debug("Found open conversation via Unthread API search", {
      conversationId: openConvo.id,
      customerId: mapping.customerId,
    });
    mapping.conversationId = openConvo.id;
    await persistMapping(mapping);
    return { conversationId: openConvo.id, isNew: false };
  }

  // 3. No open conversations found — create a new one
  LogEngine.debug("No open conversation found, creating new one", { customerId: mapping.customerId });
  const title = `WhatsApp: ${mapping.profileName || mapping.phone}`;
  const convo = await unthread.createConversation(mapping.customerId, title, initialMessage, onBehalfOf);

  // Persist updated mapping and reverse index
  mapping.conversationId = convo.id;
  await persistMapping(mapping);

  return { conversationId: convo.id, isNew: true, friendlyId: convo.friendlyId };
}

// Look up phone number by conversation ID (for outbound agent replies)
export async function findPhoneByConversationId(
  conversationId: string,
): Promise<string | null> {
  // Check in-memory cache first
  const cached = convoCache.get(conversationId);
  if (cached) return cached;

  // Fallback to Nuvex storage
  const stored = await storage().getNamespaced(NS_CONVO, conversationId) as string | null;
  if (stored && typeof stored === "string") {
    convoCache.set(conversationId, stored);
  }
  return stored;
}
