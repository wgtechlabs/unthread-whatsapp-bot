import { LogEngine } from "@wgtechlabs/log-engine";
import { sendExpiryWarningMessage } from "./system-messages";

// Default: warn at 23 hours (1 hour before the 24h window closes)
const WARNING_THRESHOLD_MS = parseInt(
  process.env.SESSION_WARNING_THRESHOLD_MS || String(23 * 60 * 60 * 1000),
  10,
);

// How often the scanner checks for expiring sessions (default: 5 minutes)
const SCAN_INTERVAL_MS = parseInt(
  process.env.SESSION_SCAN_INTERVAL_MS || String(5 * 60 * 1000),
  10,
);

interface SessionData {
  conversationId: string;
  phone: string;
  ticketNumber: string;
  lastCustomerMessageAt: number; // unix timestamp ms
  warningSent: boolean;
}

// In-memory session tracker — keyed by conversationId
const sessions = new Map<string, SessionData>();

let scanTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Track a customer message for session expiry monitoring.
 * Call this on every inbound customer message to reset the 24h window timer.
 */
export function trackCustomerMessage(
  conversationId: string,
  phone: string,
  ticketNumber: string,
): void {
  sessions.set(conversationId, {
    conversationId,
    phone,
    ticketNumber,
    lastCustomerMessageAt: Date.now(),
    warningSent: false,
  });
  LogEngine.debug("Session tracked", { conversationId, phone });
}

/**
 * Clear a session when the ticket is closed or no longer active.
 */
export function clearSession(conversationId: string): void {
  if (sessions.delete(conversationId)) {
    LogEngine.debug("Session cleared", { conversationId });
  }
}

/**
 * Scan all tracked sessions and send expiry warnings for those approaching the 24h window.
 */
async function scanForExpiringSessions(): Promise<void> {
  const now = Date.now();
  const pending: SessionData[] = [];

  for (const session of sessions.values()) {
    if (session.warningSent) continue;

    const elapsed = now - session.lastCustomerMessageAt;
    if (elapsed >= WARNING_THRESHOLD_MS) {
      pending.push(session);
    }
  }

  if (pending.length === 0) return;

  LogEngine.debug(`Found ${pending.length} session(s) approaching expiry`);

  for (const session of pending) {
    try {
      const sent = await sendExpiryWarningMessage(session.phone, session.ticketNumber);
      if (sent) {
        session.warningSent = true;
        LogEngine.info("Session expiry warning sent", {
          conversationId: session.conversationId,
          phone: session.phone,
        });
      }
    } catch (err) {
      LogEngine.error("Failed to send session expiry warning", {
        conversationId: session.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Start the periodic session expiry scanner.
 */
export function startSessionTimer(): void {
  if (scanTimer) return;

  scanTimer = setInterval(async () => {
    try {
      await scanForExpiringSessions();
    } catch (err) {
      LogEngine.error("Session timer scan error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, SCAN_INTERVAL_MS);

  LogEngine.info("Session timer started", {
    warningThresholdMs: WARNING_THRESHOLD_MS,
    scanIntervalMs: SCAN_INTERVAL_MS,
  });
}

/**
 * Stop the periodic session expiry scanner.
 */
export function stopSessionTimer(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
    LogEngine.info("Session timer stopped");
  }
}
