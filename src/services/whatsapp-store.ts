import type { NuvexClient } from "@wgtechlabs/nuvex";
import { LogEngine } from "@wgtechlabs/log-engine";
import type { WhatsAppCustomerRecord, WhatsAppTicketRecord } from "../types";

const NS_CUSTOMER_PHONE = "wa:customer:phone";
const NS_CUSTOMER_ID = "wa:customer:id";
const NS_TICKET_CONVERSATION = "wa:ticket:conversation";
const NS_TICKET_FRIENDLY = "wa:ticket:friendly";
const NS_CONVERSATION_PHONE = "wa:index:conversation-phone";

const customerByPhoneCache = new Map<string, WhatsAppCustomerRecord>();
const customerByIdCache = new Map<string, WhatsAppCustomerRecord>();
const ticketByConversationCache = new Map<string, WhatsAppTicketRecord>();
const ticketByFriendlyIdCache = new Map<string, WhatsAppTicketRecord>();
const phoneByConversationCache = new Map<string, string>();

let _storage: NuvexClient;

function storage(): NuvexClient {
  if (!_storage) {
    throw new Error("WhatsApp store not initialized. Call initializeWhatsAppStore() first.");
  }

  return _storage;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidCustomerRecord(value: unknown): value is WhatsAppCustomerRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.phone)
    && isNonEmptyString(record.customerId)
    && (record.conversationId === null || record.conversationId === undefined || typeof record.conversationId === "string")
    && (record.profileName === null || record.profileName === undefined || typeof record.profileName === "string")
    && isNonEmptyString(record.createdAt)
    && isNonEmptyString(record.updatedAt);
}

function isValidTicketRecord(value: unknown): value is WhatsAppTicketRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.conversationId)
    && isNonEmptyString(record.customerId)
    && isNonEmptyString(record.phone)
    && (record.friendlyId === null || record.friendlyId === undefined || typeof record.friendlyId === "string")
    && (record.status === null || record.status === undefined || typeof record.status === "string")
    && (record.profileName === null || record.profileName === undefined || typeof record.profileName === "string")
    && isNonEmptyString(record.createdAt)
    && isNonEmptyString(record.updatedAt);
}

function primeCustomerCaches(record: WhatsAppCustomerRecord): void {
  customerByPhoneCache.set(record.phone, record);
  customerByIdCache.set(record.customerId, record);
}

function primeTicketCaches(record: WhatsAppTicketRecord): void {
  ticketByConversationCache.set(record.conversationId, record);
  phoneByConversationCache.set(record.conversationId, record.phone);

  if (record.friendlyId) {
    ticketByFriendlyIdCache.set(record.friendlyId, record);
  }
}

export function initializeWhatsAppStore(client: NuvexClient): void {
  _storage = client;
}

export async function storeCustomer(record: Omit<WhatsAppCustomerRecord, "createdAt" | "updatedAt"> & Partial<Pick<WhatsAppCustomerRecord, "createdAt" | "updatedAt">>): Promise<WhatsAppCustomerRecord> {
  const timestamp = nowIso();
  const normalized: WhatsAppCustomerRecord = {
    ...record,
    createdAt: record.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  await Promise.all([
    storage().setNamespaced(NS_CUSTOMER_PHONE, normalized.phone, normalized),
    storage().setNamespaced(NS_CUSTOMER_ID, normalized.customerId, normalized),
  ]);

  primeCustomerCaches(normalized);
  return normalized;
}

export async function getCustomerByPhone(phone: string): Promise<WhatsAppCustomerRecord | null> {
  const cached = customerByPhoneCache.get(phone);
  if (cached) {
    return cached;
  }

  const stored = await storage().getNamespaced(NS_CUSTOMER_PHONE, phone);
  if (!isValidCustomerRecord(stored)) {
    if (stored !== null && stored !== undefined) {
      LogEngine.warn("Ignoring invalid WhatsApp customer record by phone", { phone, raw: stored });
    }
    return null;
  }

  primeCustomerCaches(stored);
  return stored;
}

export async function getCustomerById(customerId: string): Promise<WhatsAppCustomerRecord | null> {
  const cached = customerByIdCache.get(customerId);
  if (cached) {
    return cached;
  }

  const stored = await storage().getNamespaced(NS_CUSTOMER_ID, customerId);
  if (!isValidCustomerRecord(stored)) {
    if (stored !== null && stored !== undefined) {
      LogEngine.warn("Ignoring invalid WhatsApp customer record by id", { customerId, raw: stored });
    }
    return null;
  }

  primeCustomerCaches(stored);
  return stored;
}

export async function storeTicket(record: Omit<WhatsAppTicketRecord, "createdAt" | "updatedAt"> & Partial<Pick<WhatsAppTicketRecord, "createdAt" | "updatedAt">>): Promise<WhatsAppTicketRecord> {
  const existing = await getTicketByConversationId(record.conversationId);
  const timestamp = nowIso();
  const normalized: WhatsAppTicketRecord = {
    ...existing,
    ...record,
    createdAt: record.createdAt ?? existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  const writes: Array<Promise<unknown>> = [
    storage().setNamespaced(NS_TICKET_CONVERSATION, normalized.conversationId, normalized),
    storage().setNamespaced(NS_CONVERSATION_PHONE, normalized.conversationId, normalized.phone),
  ];

  if (normalized.friendlyId) {
    writes.push(storage().setNamespaced(NS_TICKET_FRIENDLY, normalized.friendlyId, normalized));
  }

  await Promise.all(writes);
  primeTicketCaches(normalized);
  return normalized;
}

export async function getTicketByConversationId(conversationId: string): Promise<WhatsAppTicketRecord | null> {
  const cached = ticketByConversationCache.get(conversationId);
  if (cached) {
    return cached;
  }

  const stored = await storage().getNamespaced(NS_TICKET_CONVERSATION, conversationId);
  if (!isValidTicketRecord(stored)) {
    if (stored !== null && stored !== undefined) {
      LogEngine.warn("Ignoring invalid WhatsApp ticket record by conversation", { conversationId, raw: stored });
    }
    return null;
  }

  primeTicketCaches(stored);
  return stored;
}

export async function getTicketByFriendlyId(friendlyId: string): Promise<WhatsAppTicketRecord | null> {
  const cached = ticketByFriendlyIdCache.get(friendlyId);
  if (cached) {
    return cached;
  }

  const stored = await storage().getNamespaced(NS_TICKET_FRIENDLY, friendlyId);
  if (!isValidTicketRecord(stored)) {
    if (stored !== null && stored !== undefined) {
      LogEngine.warn("Ignoring invalid WhatsApp ticket record by friendly id", { friendlyId, raw: stored });
    }
    return null;
  }

  primeTicketCaches(stored);
  return stored;
}

export async function getPhoneByConversationId(conversationId: string): Promise<string | null> {
  const cached = phoneByConversationCache.get(conversationId);
  if (cached) {
    return cached;
  }

  const stored = await storage().getNamespaced(NS_CONVERSATION_PHONE, conversationId);
  if (isNonEmptyString(stored)) {
    phoneByConversationCache.set(conversationId, stored);
    return stored;
  }

  const ticket = await getTicketByConversationId(conversationId);
  if (ticket) {
    return ticket.phone;
  }

  return null;
}

export async function updateTicketStatus(
  conversationId: string,
  status: string,
  friendlyId?: string | null,
): Promise<WhatsAppTicketRecord | null> {
  const existing = await getTicketByConversationId(conversationId);
  if (!existing) {
    return null;
  }

  return storeTicket({
    ...existing,
    status,
    friendlyId: friendlyId ?? existing.friendlyId,
  });
}