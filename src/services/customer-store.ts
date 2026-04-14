import { LogEngine } from "@wgtechlabs/log-engine";
import { isReusableConversationStatus } from "../types";
import type { CustomerMapping } from "../types";
import * as unthread from "./unthread";
import { buildWhatsAppFallbackEmail, formatWhatsAppIdentity } from "./whatsapp-identity";
import {
  deleteCustomerRecord,
  getCustomerById,
  getCustomerByPhone,
  getPhoneByConversationId,
  initializeWhatsAppStore,
  storeCustomer,
  storeTicket,
} from "./whatsapp-store";


export function setStorage(client: Parameters<typeof initializeWhatsAppStore>[0]): void {
  initializeWhatsAppStore(client);
}

function toCustomerMapping(record: {
  phone: string;
  customerId: string;
  conversationId: string | null;
  profileName: string | null;
  email: string | null;
}): CustomerMapping {
  return {
    phone: record.phone,
    customerId: record.customerId,
    conversationId: record.conversationId,
    profileName: record.profileName,
    email: record.email,
  };
}

async function hydrateExistingCustomer(
  phone: string,
  profileName: string | null,
  email: string | null,
): Promise<CustomerMapping | null> {
  const existingCustomer = email
    ? ((await unthread.findCustomerByEmail(email)) ?? (await unthread.findCustomerByPhone(phone)))
    : await unthread.findCustomerByPhone(phone);

  if (!existingCustomer) {
    return null;
  }

  const recoveredEmail =
    typeof existingCustomer.email === "string" && existingCustomer.email.trim().length > 0
      ? existingCustomer.email.trim()
      : (email ?? unthread.resolveCustomerEmail(null, phone));

  LogEngine.debug("Customer recovered from Unthread API", {
    phone,
    customerId: existingCustomer.id,
    email: recoveredEmail,
  });

  const openConvo = await unthread.findOpenConversationByCustomer(existingCustomer.id);

  const customerRecord = await storeCustomer({
    phone,
    customerId: existingCustomer.id,
    conversationId: openConvo?.id ?? null,
    profileName,
    email: recoveredEmail,
  });

  if (openConvo) {
    try {
      await storeTicket({
        conversationId: openConvo.id,
        customerId: existingCustomer.id,
        phone,
        friendlyId: openConvo.friendlyId ?? null,
        status: openConvo.status,
        profileName,
      });
    } catch (error) {
      const rollbackOk = await deleteCustomerRecord(phone, existingCustomer.id);
      LogEngine.error("Failed to persist recovered WhatsApp ticket state", {
        phone,
        customerId: existingCustomer.id,
        conversationId: openConvo.id,
        rollbackOk,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return toCustomerMapping(customerRecord);
}

export async function findExistingCustomer(
  phone: string,
  profileName: string | null,
): Promise<CustomerMapping | null> {
  const stored = await getCustomerByPhone(phone);
  if (stored) {
    LogEngine.debug("Customer resolved from WhatsApp store", {
      phone,
      customerId: stored.customerId,
    });
    return toCustomerMapping(stored);
  }

  const fallbackEmail = buildWhatsAppFallbackEmail(phone);
  return hydrateExistingCustomer(phone, profileName, fallbackEmail);
}

// Resolve or create an Unthread customer from a WhatsApp message
export async function resolveCustomer(
  phone: string,
  profileName: string | null,
  email: string,
): Promise<CustomerMapping> {
  const stored = await getCustomerByPhone(phone);
  if (stored) {
    const normalizedProfileName = profileName ?? stored.profileName;
    const normalizedEmail = stored.email ?? email;

    if (stored.profileName !== normalizedProfileName || stored.email !== normalizedEmail) {
      const updatedRecord = await storeCustomer({
        ...stored,
        profileName: normalizedProfileName,
        email: normalizedEmail,
      });
      LogEngine.debug("Customer refreshed in WhatsApp store", {
        phone,
        customerId: updatedRecord.customerId,
        email: updatedRecord.email,
      });
      return toCustomerMapping(updatedRecord);
    }

    LogEngine.debug("Customer resolved from WhatsApp store", {
      phone,
      customerId: stored.customerId,
    });
    return toCustomerMapping(stored);
  }

  const existingCustomer = await hydrateExistingCustomer(phone, profileName, email);
  if (existingCustomer) {
    return existingCustomer;
  }

  LogEngine.debug("Creating new Unthread customer", { phone, profileName, email });
  const customer = await unthread.createCustomer(
    phone,
    formatWhatsAppIdentity(profileName, phone),
    email,
  );

  const customerRecord = await storeCustomer({
    phone,
    customerId: customer.id,
    conversationId: null,
    profileName,
    email,
  });

  return toCustomerMapping(customerRecord);
}

// Get or create an active conversation for a customer
export async function resolveConversation(
  mapping: CustomerMapping,
  initialMessage: string,
  onBehalfOf: { email: string; name: string },
): Promise<{ conversationId: string; isNew: boolean; friendlyId?: string | number }> {
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
        ...((await getCustomerById(mapping.customerId)) ?? mapping),
        phone: mapping.phone,
        customerId: mapping.customerId,
        conversationId: null,
        profileName: mapping.profileName,
      });
      mapping.conversationId = updatedCustomer.conversationId;
    } catch (err) {
      LogEngine.debug("Failed to fetch stored conversation, will search for open ones", {
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
      ...((await getCustomerById(mapping.customerId)) ?? mapping),
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
  LogEngine.debug("No open conversation found, creating new one", {
    customerId: mapping.customerId,
  });
  const title = `[WhatsApp Ticket] ${formatWhatsAppIdentity(mapping.profileName, mapping.phone)}`;
  const convo = await unthread.createConversation(
    mapping.customerId,
    title,
    initialMessage,
    onBehalfOf,
  );

  const updatedCustomer = await storeCustomer({
    ...((await getCustomerById(mapping.customerId)) ?? mapping),
    phone: mapping.phone,
    customerId: mapping.customerId,
    conversationId: convo.id,
    profileName: mapping.profileName,
    ...(mapping.email !== null && mapping.email !== undefined ? { email: mapping.email } : {}),
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
export async function findPhoneByConversationId(conversationId: string): Promise<string | null> {
  return getPhoneByConversationId(conversationId);
}
