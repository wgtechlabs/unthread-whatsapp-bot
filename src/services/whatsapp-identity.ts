function cleanPhoneDigits(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export function buildWhatsAppFallbackEmail(phone: string): string | null {
  const digits = cleanPhoneDigits(phone);
  if (!digits) {
    return null;
  }

  return `${digits}@whatsapp.user`;
}

export function getWhatsAppDisplayName(profileName: string | null | undefined): string {
  const normalized = profileName?.trim();
  return normalized && normalized.length > 0 ? normalized : "No name";
}

export function formatWhatsAppIdentity(
  profileName: string | null | undefined,
  phone: string,
): string {
  return `${getWhatsAppDisplayName(profileName)} (${phone})`;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailPattern.test(normalized)) {
    return null;
  }

  if (normalized.length > 254 || normalized.includes("..")) {
    return null;
  }

  return normalized;
}

export function isCancelMessage(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "cancel" || normalized === "/cancel";
}
