import { describe, expect, test } from "bun:test";
import { resolveStatusTemplateKey } from "./system-message-status";

describe("resolveStatusTemplateKey", () => {
  test("maps hyphenated in-progress status to the in-progress template", () => {
    expect(resolveStatusTemplateKey("in-progress", "open")).toBe("ticket_in_progress");
  });

  test("maps underscored in_progress status to the in-progress template", () => {
    expect(resolveStatusTemplateKey("in_progress", "open")).toBe("ticket_in_progress");
  });

  test("treats on-hold to in-progress as resumed", () => {
    expect(resolveStatusTemplateKey("in-progress", "on-hold")).toBe("ticket_resumed");
  });

  test("treats waiting to open as resumed", () => {
    expect(resolveStatusTemplateKey("open", "waiting")).toBe("ticket_resumed");
  });

  test("returns null for plain open status changes", () => {
    expect(resolveStatusTemplateKey("open", "closed")).toBeNull();
  });

  test("returns null for unknown statuses", () => {
    expect(resolveStatusTemplateKey("escalated", "open")).toBeNull();
  });
});
