import { describe, expect, test } from "bun:test";
import { recoverFromEmailPromptFailure } from "./email-prompt-recovery";

describe("recoverFromEmailPromptFailure", () => {
  test("forwards the original message when prompt delivery reports failure", async () => {
    let cleared = 0;
    let forwarded = 0;

    await recoverFromEmailPromptFailure({
      phone: "+15550000001",
      profileName: "Tester",
      initialMessage: "Need help",
      stage: "initial",
      clearPendingState: async () => {
        cleared += 1;
        return true;
      },
      forwardFallback: async () => {
        forwarded += 1;
      },
    });

    expect(cleared).toBe(1);
    expect(forwarded).toBe(1);
  });

  test("still forwards the original message when pending state cannot be cleared", async () => {
    let forwarded = 0;

    await recoverFromEmailPromptFailure({
      phone: "+15550000002",
      profileName: "Tester",
      initialMessage: "Need help",
      stage: "retry",
      clearPendingState: async () => false,
      forwardFallback: async () => {
        forwarded += 1;
      },
      error: new Error("Twilio send failed"),
    });

    expect(forwarded).toBe(1);
  });
});
