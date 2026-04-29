import { describe, expect, test } from "bun:test";
import {
  fileNameFromMimeType,
  normalizeMimeType,
  sanitizeFileName,
  validateAttachmentCount,
  validateAttachmentSize,
  validateMimeType,
} from "./attachment-validator";

describe("attachment-validator", () => {
  describe("normalizeMimeType", () => {
    test("strips charset and whitespace parameters", () => {
      expect(normalizeMimeType("image/jpeg; charset=utf-8")).toBe("image/jpeg");
    });

    test("lowercases the MIME type", () => {
      expect(normalizeMimeType("Image/JPEG")).toBe("image/jpeg");
    });

    test("returns bare type unchanged", () => {
      expect(normalizeMimeType("application/pdf")).toBe("application/pdf");
    });
  });

  describe("validateMimeType", () => {
    test("accepts supported image types", () => {
      expect(validateMimeType("image/jpeg").valid).toBe(true);
      expect(validateMimeType("image/png").valid).toBe(true);
      expect(validateMimeType("image/gif").valid).toBe(true);
    });

    test("accepts supported document types", () => {
      expect(validateMimeType("application/pdf").valid).toBe(true);
    });

    test("rejects unsupported MIME types", () => {
      const result = validateMimeType("application/x-custom");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Unsupported MIME type");
    });

    test("strips parameters before checking", () => {
      expect(validateMimeType("image/png; charset=utf-8").valid).toBe(true);
    });
  });

  describe("validateAttachmentSize", () => {
    const maxBytes = 16 * 1024 * 1024; // 16 MB

    test("accepts a file within the limit", () => {
      expect(validateAttachmentSize("application/pdf", 1024, maxBytes).valid).toBe(true);
    });

    test("rejects empty files", () => {
      const result = validateAttachmentSize("image/jpeg", 0, maxBytes);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("empty");
    });

    test("rejects images over 5 MB even when general limit is higher", () => {
      const sixMb = 6 * 1024 * 1024;
      const result = validateAttachmentSize("image/jpeg", sixMb, maxBytes);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("too large");
    });

    test("accepts images at exactly 5 MB", () => {
      const fiveMb = 5 * 1024 * 1024;
      expect(validateAttachmentSize("image/jpeg", fiveMb, maxBytes).valid).toBe(true);
    });

    test("rejects non-image over the configured general limit", () => {
      const result = validateAttachmentSize("application/pdf", maxBytes + 1, maxBytes);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("too large");
    });
  });

  describe("validateAttachmentCount", () => {
    test("accepts count within limit", () => {
      expect(validateAttachmentCount(1).valid).toBe(true);
      expect(validateAttachmentCount(10).valid).toBe(true);
    });

    test("rejects count exceeding 10", () => {
      const result = validateAttachmentCount(11);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Too many attachments");
    });
  });

  describe("sanitizeFileName", () => {
    test("strips path-separator characters", () => {
      expect(sanitizeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    });

    test("strips null bytes", () => {
      expect(sanitizeFileName("file\0name.pdf")).toBe("filename.pdf");
    });

    test("falls back to 'attachment' for empty names", () => {
      expect(sanitizeFileName("   ")).toBe("attachment");
      expect(sanitizeFileName("")).toBe("attachment");
    });

    test("truncates long names to 200 characters", () => {
      const longName = "a".repeat(300);
      expect(sanitizeFileName(longName).length).toBe(200);
    });

    test("leaves safe names unchanged", () => {
      expect(sanitizeFileName("invoice_2024.pdf")).toBe("invoice_2024.pdf");
    });
  });

  describe("fileNameFromMimeType", () => {
    test("returns a suitable filename for known MIME types", () => {
      expect(fileNameFromMimeType("image/jpeg")).toBe("image.jpg");
      expect(fileNameFromMimeType("application/pdf")).toBe("document.pdf");
      expect(fileNameFromMimeType("audio/mpeg")).toBe("audio.mp3");
    });

    test("returns 'attachment' for unknown MIME types", () => {
      expect(fileNameFromMimeType("application/x-unknown")).toBe("attachment");
    });
  });
});
