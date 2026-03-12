// Twilio incoming WhatsApp message payload
export interface TwilioIncomingMessage {
  MessageSid: string;
  AccountSid: string;
  From: string; // "whatsapp:+1234567890"
  To: string; // "whatsapp:+0987654321"
  Body: string;
  NumMedia: string;
  ProfileName?: string;
  WaId?: string; // WhatsApp ID (phone number without +)
}

export type UnthreadFriendlyId = string | number;

// Unthread API types
export interface UnthreadCustomer {
  id: string;
  name: string;
  email: string;
  phoneNumber?: string;
}

export interface UnthreadConversation {
  id: string;
  customerId: string;
  status: string;
  title?: string;
  friendlyId?: UnthreadFriendlyId;
}

export interface UnthreadMessage {
  id: string;
  conversationId: string;
  body: string;
  type: string;
}

// Unthread queued event payload from unthread-webhook-server
export interface UnthreadQueuedEvent {
  platform?: string;
  type: string;
  sourcePlatform?: string;
  targetPlatform?: string;
  timestamp?: number | string;
  data: {
    id?: string;
    conversationId?: string;
    body?: string;
    content?: string;
    text?: string;
    customerId?: string;
    type?: string;
    status?: string;
    previousStatus?: string;
    friendlyId?: UnthreadFriendlyId;
    [key: string]: unknown;
  };
}

// Internal mapping: WhatsApp phone -> Unthread customer
export interface CustomerMapping {
  phone: string; // E.164 format: +1234567890
  customerId: string;
  conversationId: string | null;
  profileName: string | null;
  email: string | null;
}

export interface WhatsAppCustomerRecord extends CustomerMapping {
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppTicketRecord {
  conversationId: string;
  customerId: string;
  phone: string;
  friendlyId: string | null;
  status: string | null;
  profileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppEmailCollectionState {
  phone: string;
  initialMessage: string;
  profileName: string | null;
  createdAt: string;
  updatedAt: string;
}
