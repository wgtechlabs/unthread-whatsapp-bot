// Supported MIME types for WhatsApp media via Twilio
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/amr",
  "video/mp4",
  "video/3gp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// Fully-supported image types with the Twilio 5 MB cap
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif"]);

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per Twilio WhatsApp image limit
const MAX_ATTACHMENTS_PER_MESSAGE = 10; // Twilio outbound mediaUrl limit

export interface AttachmentValidationResult {
  valid: boolean;
  reason?: string;
}

// Normalize a raw MIME type string by stripping parameters (e.g. "image/jpeg; charset=…")
export function normalizeMimeType(raw: string): string {
  return raw.split(";")[0].trim().toLowerCase();
}

export function validateMimeType(mimeType: string): AttachmentValidationResult {
  const normalized = normalizeMimeType(mimeType);
  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    return { valid: false, reason: `Unsupported MIME type: ${normalized}` };
  }
  return { valid: true };
}

export function validateAttachmentSize(
  mimeType: string,
  sizeBytes: number,
  maxBytes: number,
): AttachmentValidationResult {
  if (sizeBytes === 0) {
    return { valid: false, reason: "Attachment is empty" };
  }

  const normalized = normalizeMimeType(mimeType);
  const effectiveMax = IMAGE_MIME_TYPES.has(normalized)
    ? Math.min(maxBytes, MAX_IMAGE_SIZE_BYTES)
    : maxBytes;

  if (sizeBytes > effectiveMax) {
    return {
      valid: false,
      reason: `Attachment too large: ${sizeBytes} bytes (max ${effectiveMax} bytes for ${normalized})`,
    };
  }

  return { valid: true };
}

export function validateAttachmentCount(count: number): AttachmentValidationResult {
  if (count > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      valid: false,
      reason: `Too many attachments: ${count} (max ${MAX_ATTACHMENTS_PER_MESSAGE})`,
    };
  }
  return { valid: true };
}

// Strip dangerous characters from file names and truncate to a safe length.
// Never returns an empty string — falls back to "attachment".
export function sanitizeFileName(rawName: string): string {
  const base = rawName
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\0/g, "")
    .trim();
  return base.slice(0, 200) || "attachment";
}

// Derive a safe file name from a MIME type when the original name is unavailable.
export function fileNameFromMimeType(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  const mimeExtensions: Record<string, string> = {
    "image/jpeg": "image.jpg",
    "image/jpg": "image.jpg",
    "image/png": "image.png",
    "image/gif": "image.gif",
    "image/webp": "image.webp",
    "audio/mpeg": "audio.mp3",
    "audio/mp4": "audio.mp4",
    "audio/ogg": "audio.ogg",
    "audio/amr": "audio.amr",
    "video/mp4": "video.mp4",
    "video/3gp": "video.3gp",
    "application/pdf": "document.pdf",
    "text/plain": "file.txt",
  };
  return mimeExtensions[normalized] ?? "attachment";
}
