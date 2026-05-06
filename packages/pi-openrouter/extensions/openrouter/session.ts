import crypto from 'node:crypto';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

// =============================================================================
// Types & State
// =============================================================================

export type OpenRouterSessionState = {
  sessionId: string;
};

// =============================================================================
// State Factory
// =============================================================================

export function createOpenRouterSessionState(): OpenRouterSessionState {
  return {
    sessionId: `pi:${crypto.randomUUID()}`,
  };
}

// =============================================================================
// Detection Logic
// =============================================================================

function isOpenRouterRequest(event: unknown, ctx: unknown): boolean {
  const ev = event as Record<string, unknown> | undefined;
  const context = ctx as Record<string, unknown> | undefined;

  // Method 1: Check model string (e.g., "openrouter/anthropic/claude-3.5-sonnet")
  const model = String(ev?.payload?.model ?? context?.model ?? '');
  if (model.includes('openrouter/')) {
    return true;
  }

  // Method 2: Check baseUrl from context.model
  // OpenRouter models have baseUrl starting with https://openrouter.ai/api/v1
  const baseUrl = (context?.model as Record<string, unknown>)?.baseUrl as string | undefined;
  if (baseUrl?.includes('openrouter.ai')) {
    return true;
  }

  // Method 3: Check for ZDR provider (Shopify routes to OpenRouter via ZDR)
  const provider = ev?.provider as Record<string, unknown> | undefined;
  if (provider?.zdr === true) {
    return true;
  }

  // Method 4: Check URL
  const url = String((ev?.url as string | undefined) ?? (ev?.endpoint as string | undefined) ?? '');
  if (url.includes('openrouter.ai')) {
    return true;
  }

  return false;
}

// =============================================================================
// Installation Functions
// =============================================================================

export function installOpenRouterSessionTracking(
  pi: ExtensionAPI,
  state: OpenRouterSessionState,
): void {
  // Hook: before_provider_request
  pi.on('before_provider_request', (event, ctx) => {
    try {
      const payload = (event as Record<string, unknown>)?.payload as Record<string, unknown>;

      // Check if this is an OpenRouter request
      const isOpenRouter = isOpenRouterRequest(event, ctx);

      if (isOpenRouter && state.sessionId) {
        // Do not overwrite existing session_id
        if ('session_id' in payload && payload.session_id !== undefined) {
          return;
        }

        // Add session_id to the payload (OpenRouter-specific field)
        const modifiedPayload = {
          ...payload,
          session_id: state.sessionId,
        };

        return modifiedPayload;
      }
      // Return undefined implicitly when not OpenRouter or no session_id needed
    } catch (err) {
      // Fail open - silently ignore errors
      return;
    }
  });
}

export function installOpenRouterSessionCommand(
  pi: ExtensionAPI,
  state: OpenRouterSessionState,
): void {
  // FR6: Add /openrouter-session command
  pi.registerCommand('openrouter-session', {
    description: 'Show the current OpenRouter session ID for request grouping',
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      // AC8: Command shows full ID, untruncated
      const output = `OpenRouter session_id\n${state.sessionId}`;

      // Use ephemeral notification or message
      ctx.ui.notify(output, 'info');
    },
  });
}
