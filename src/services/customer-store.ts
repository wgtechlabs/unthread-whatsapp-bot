import { LogEngine } from "@wgtechlabs/log-engine";
import type { CustomerMapping } from "../types";
import * as unthread from "./unthread";
import {
  getCustomerById,
  getCustomerByPhone,
  getPhoneByConversationId,
  initializeWhatsAppStore,
  storeCustomer,
  storeTicket,
} from "./whatsapp-store";

function isReusableConversationStatus(status: string | null | undefined): boolean {
  return status === "open"
    || status === "waiting"
    || status === "on_hold"
    || status === "on-hold"
    || status === "in_progress";
}

export function setStorage(client: Parameters<typeof initializeWhatsAppStore>[0]): void {
  initializeWhatsAppStore(client);
}

function toCustomerMapping(record: {
  phone: string;
  customerId: string;
  conversationId: string | null;
  profileName: string | null;
}): CustomerMapping {
  return {
    phone: record.phone,
    customerId: record.customerId,
    conversationId: record.conversationId,
    profileName: record.profileName,
  };
}

// Resolve or create an Unthread customer from a WhatsApp message
export async function resolveCustomer(
  phone: string,
  profileName: string | null,
): Promise<CustomerMapping> {
  const stored = await getCustomerByPhone(phone);
  if (stored) {
    LogEngine.debug("Customer resolved from WhatsApp store", { phone, customerId: stored.customerId });
    return toCustomerMapping(stored);
  }

  // Try to find existing customer in Unthread by dummy email
  const cleanPhone = phone.replace(/[^0-9]/g, "");
  const dummyEmail = `${cleanPhone}@whatsapp.user`;
  const existingCustomer = await unthread.findCustomerByEmail(dummyEmail);

  if (existingCustomer) {
    LogEngine.debug("Customer recovered from Unthread API", { phone, customerId: existingCustomer.id });

    const openConvo = await unthread.findOpenConversationByCustomer(existingCustomer.id);

    const customerRecord = await storeCustomer({
      phone,
      customerId: existingCustomer.id,
      conversationId: openConvo?.id ?? null,
      profileName,
    });

    if (openConvo) {
      await storeTicket({
        conversationId: openConvo.id,
        customerId: existingCustomer.id,
        phone,
        friendlyId: openConvo.friendlyId ?? null,
        status: openConvo.status,
        profileName,
      });
    }

    return toCustomerMapping(customerRecord);
  }

  LogEngine.debug("Creating new Unthread customer", { phone, profileName });
  const name = profileName || phone;
  const customer = await unthread.createCustomer(phone, name);

  const customerRecord = await storeCustomer({
    phone,
    customerId: customer.id,
    conversationId: null,
    profileName,
  });

  return toCustomerMapping(customerRecord);
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
      if (isReusableConversationStatus(convo.status)) {
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
      const updatedCustomer = await storeCustomer({
        ...(await getCustomerById(mapping.customerId) ?? mapping),
        phone: mapping.phone,
        customerId: mapping.customerId,
        conversationId: null,
        profileName: mapping.profileName,
      });
      mapping.conversationId = updatedCustomer.conversationId;
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
    const updatedCustomer = await storeCustomer({
      ...(await getCustomerById(mapping.customerId) ?? mapping),
      phone: mapping.phone,
      customerId: mapping.customerId,
      conversationId: openConvo.id,
      profileName: mapping.profileName,
    });
    await storeTicket({
      conversationId: openConvo.id,
      customerId: mapping.customerId,
      phone: mapping.phone,
      friendlyId: openConvo.friendlyId ?? null,
      status: openConvo.status,
      profileName: mapping.profileName,
    });
    mapping.conversationId = updatedCustomer.conversationId;
    return { conversationId: openConvo.id, isNew: false };
  }

  // 3. No open conversations found — create a new one
  LogEngine.debug("No open conversation found, creating new one", { customerId: mapping.customerId });
  const title = `WhatsApp: ${mapping.profileName || mapping.phone}`;
  const convo = await unthread.createConversation(mapping.customerId, title, initialMessage, onBehalfOf);

  const updatedCustomer = await storeCustomer({
    ...(await getCustomerById(mapping.customerId) ?? mapping),
    phone: mapping.phone,
    customerId: mapping.customerId,
    conversationId: convo.id,
    profileName: mapping.profileName,
  });
  await storeTicket({
    conversationId: convo.id,
    customerId: mapping.customerId,
    phone: mapping.phone,
    friendlyId: convo.friendlyId ?? null,
    status: convo.status,
    profileName: mapping.profileName,
  });
  mapping.conversationId = updatedCustomer.conversationId;

  return { conversationId: convo.id, isNew: true, friendlyId: convo.friendlyId };
}

// Look up phone number by conversation ID (for outbound agent replies)
export async function findPhoneByConversationId(
  conversationId: string,
): Promise<string | null> {
  return getPhoneByConversationId(conversationId);
}
