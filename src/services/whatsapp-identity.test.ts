import { describe, expect, test } from "bun:test";
import {
  buildWhatsAppFallbackEmail,
  formatWhatsAppIdentity,
  isCancelMessage,
  normalizeEmail,
} from "./whatsapp-identity";

describe("whatsapp identity helpers", () => {
  test("buildWhatsAppFallbackEmail returns sanitized fallback email", () => {
    expect(buildWhatsAppFallbackEmail("+1 (555) 123-4567")).toBe("15551234567@whatsapp.user");
  });

  test("buildWhatsAppFallbackEmail returns null when no digits are present", () => {
    expect(buildWhatsAppFallbackEmail("whatsapp:invalid")).toBeNull();
  });

  test("normalizeEmail trims and lowercases valid email input", () => {
    expect(normalizeEmail("  USER.Name+tag@Example.COM  ")).toBe("user.name+tag@example.com");
  });

  test("normalizeEmail rejects whitespace-only input", () => {
    expect(normalizeEmail("   ")).toBeNull();
  });

  test("isCancelMessage accepts cancel commands", () => {
    expect(isCancelMessage("cancel")).toBe(true);
    expect(isCancelMessage(" /cancel ")).toBe(true);
  });

  test("formatWhatsAppIdentity falls back to a default display name", () => {
    expect(formatWhatsAppIdentity("   ", "+15551234567")).toBe("No name (+15551234567)");
  });
});
