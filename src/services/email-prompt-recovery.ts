import { LogEngine } from "@wgtechlabs/log-engine";

export interface RecoverFromEmailPromptFailureOptions {
  phone: string;
  profileName: string | null;
  initialMessage: string;
  stage: "initial" | "retry";
  clearPendingState: () => Promise<boolean>;
  forwardFallback: () => Promise<void>;
  error?: unknown;
}

export async function recoverFromEmailPromptFailure(
  options: RecoverFromEmailPromptFailureOptions,
): Promise<void> {
  const { phone, profileName, initialMessage, stage, clearPendingState, forwardFallback, error } =
    options;

  let cleared = false;
  try {
    cleared = await clearPendingState();
  } catch (clearError) {
    LogEngine.error("Failed to clear pending WhatsApp email collection state", {
      phone,
      profileName,
      stage,
      error: clearError instanceof Error ? clearError.message : String(clearError),
    });
  }

  if (!cleared) {
    LogEngine.warn("Email prompt failure recovery continuing with uncleared pending state", {
      phone,
      profileName,
      stage,
      hasInitialMessage: initialMessage.length > 0,
    });
  }

  if (error === undefined) {
    LogEngine.warn("Email prompt delivery failed; falling back to immediate ticket creation", {
      phone,
      profileName,
      stage,
    });
  } else {
    LogEngine.error("Email prompt delivery failed; falling back to immediate ticket creation", {
      phone,
      profileName,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await forwardFallback();
}
