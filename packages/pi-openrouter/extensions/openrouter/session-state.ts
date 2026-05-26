import crypto from 'node:crypto';
import { formatSessionId } from './session.js';

/**
 * Session state manager for OpenRouter session IDs.
 * Ensures stable session IDs within a Pi session and proper reset across sessions.
 */
export interface SessionState {
  /**
   * Get the current session ID, creating one if needed.
   * The ID is cached and stable for the lifetime of this SessionState instance.
   */
  getCurrentSessionId(ctx: { sessionManager: { getSessionId(): string } }): string;

  /**
   * Handle session_start lifecycle event.
   * Checks if the raw session ID has changed and updates state accordingly.
   * - If raw ID differs from cached: reset and format new ID
   * - If raw ID is same: preserve cached formatted ID
   * - If raw ID is empty/throws: clear state for fresh fallback
   */
  startSession(ctx: { sessionManager: { getSessionId(): string } }): void;

  /**
   * Reset the cached session ID. Call this on session_shutdown
   * to ensure fresh IDs for new sessions.
   */
  reset(): void;

  /**
   * Peek at the current cached session ID without initializing one.
   * Returns null if no session ID has been cached yet.
   */
  peek(): string | null;
}

class SessionStateImpl implements SessionState {
  private cachedSessionId: string | null = null;
  private cachedRawSessionId: string | null = null;

  getCurrentSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
    if (this.cachedSessionId) {
      return this.cachedSessionId;
    }

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      let formattedSessionId: string;

      if (sessionId && sessionId !== '') {
        formattedSessionId = formatSessionId(sessionId);
        this.cachedRawSessionId = sessionId;
      } else {
        // Empty session ID: generate fallback UUID
        formattedSessionId = formatSessionId(crypto.randomUUID());
        this.cachedRawSessionId = null;
      }

      this.cachedSessionId = formattedSessionId;
      return formattedSessionId;
    } catch {
      // Session manager threw error: generate fallback UUID
      const fallbackId = formatSessionId(crypto.randomUUID());
      this.cachedSessionId = fallbackId;
      this.cachedRawSessionId = null;
      return fallbackId;
    }
  }

  startSession(ctx: { sessionManager: { getSessionId(): string } }): void {
    try {
      const rawSessionId = ctx.sessionManager.getSessionId();

      if (rawSessionId && rawSessionId !== '') {
        // Non-empty session ID from manager
        if (this.cachedRawSessionId !== rawSessionId) {
          // Raw session ID changed - reset and format new ID
          this.cachedRawSessionId = rawSessionId;
          this.cachedSessionId = formatSessionId(rawSessionId);
        }
        // else: same raw ID, preserve cached formatted ID
      } else {
        // Empty session ID - clear state for fresh fallback
        this.cachedSessionId = null;
        this.cachedRawSessionId = null;
      }
    } catch {
      // Session manager threw - clear state for fresh fallback
      this.cachedSessionId = null;
      this.cachedRawSessionId = null;
    }
  }

  reset(): void {
    this.cachedSessionId = null;
    this.cachedRawSessionId = null;
  }

  peek(): string | null {
    return this.cachedSessionId;
  }
}

/**
 * Create a new SessionState instance.
 * Each Pi session should get its own instance.
 */
export function createSessionState(): SessionState {
  return new SessionStateImpl();
}
