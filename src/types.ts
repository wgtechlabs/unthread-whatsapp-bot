// Returns true for conversation statuses that can still receive new messages
export function isReusableConversationStatus(status: string | null | undefined): boolean {
  return (
    status === "open" ||
    status === "waiting" ||
    status === "on_hold" ||
    status === "on-hold" ||
    status === "in_progress"
  );
}

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
  // Dynamic media fields for up to 10 attachments (Twilio WhatsApp media)
  MediaUrl0?: string;
  MediaUrl1?: string;
  MediaUrl2?: string;
  MediaUrl3?: string;
  MediaUrl4?: string;
  MediaUrl5?: string;
  MediaUrl6?: string;
  MediaUrl7?: string;
  MediaUrl8?: string;
  MediaUrl9?: string;
  MediaContentType0?: string;
  MediaContentType1?: string;
  MediaContentType2?: string;
  MediaContentType3?: string;
  MediaContentType4?: string;
  MediaContentType5?: string;
  MediaContentType6?: string;
  MediaContentType7?: string;
  MediaContentType8?: string;
  MediaContentType9?: string;
}

// A single inbound media attachment downloaded from Twilio
export interface InboundAttachment {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  originalMediaUrl: string; // Original Twilio media URL for deferred re-download
}

// Metadata stored in pending email collection state for deferred attachment upload
export interface PendingAttachmentMeta {
  mediaUrl: string; // Twilio-authenticated media URL (re-downloaded after email capture)
  contentType: string;
  fileName: string;
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

// A single file record from the outbound webhook event (unthread-webhook-server format)
export interface OutboundFileRecord {
  id?: string; // Slack-style file ID (e.g. "F12345")
  fileId?: string; // Alternate file ID field from webhook payloads
  file_id?: string; // Slack-style snake_case file ID
  name?: string;
  title?: string;
  size?: number;
  mimetype?: string;
  mimeType?: string;
  type?: string;
  urlPrivate?: string;
  urlPrivateDownload?: string;
  url_private?: string;
  url_private_download?: string;
}

// Attachment metadata block from unthread-webhook-server
export interface OutboundAttachmentsMeta {
  hasFiles: boolean;
  fileCount: number;
  totalSize?: number;
  types?: string[];
  names?: string[];
}

export interface UnthreadOutboundMetadata {
  event_type?: string;
  event_payload?: {
    userId?: string;
    attachments?: unknown[];
    conversationId?: string;
    conversationUpdates?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
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
    teamId?: string;
    body?: string;
    content?: string;
    text?: string;
    customerId?: string;
    type?: string;
    status?: string;
    previousStatus?: string;
    friendlyId?: UnthreadFriendlyId;
    files?: OutboundFileRecord[] | null;
    metadata?: UnthreadOutboundMetadata;
    [key: string]: unknown;
  };
  attachments?: OutboundAttachmentsMeta;
}

// Short-lived record stored for a media proxy token.
// Security invariant: this metadata is the only bridge between Twilio's public
// media URL and Unthread's private file API. Keep tokens short-lived, keep
// downloadUrl restricted to the Unthread API origin, and preserve conversationId
// so dashboard UUID attachments can use /conversations/:id/files/:fileId/full.
export interface MediaProxyTokenRecord {
  token: string;
  fileId?: string; // Slack F... ID or dashboard UUID attachment ID
  conversationId?: string; // Required for dashboard UUID attachment downloads
  slackTeamId?: string; // Slack workspace team ID (e.g. "T0123ABCDE"), enables /slack/files endpoint
  fileName: string;
  mimeType: string;
  fileSize?: number;
  downloadUrl?: string; // Direct download URL when file is on the Unthread API origin
  expiresAt: string; // ISO timestamp
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
  friendlyId: UnthreadFriendlyId | null;
  status: string | null;
  profileName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppEmailCollectionState {
  phone: string;
  initialMessage: string;
  profileName: string | null;
  pendingAttachments?: PendingAttachmentMeta[];
  createdAt: string;
  updatedAt: string;
}
