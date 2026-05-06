import type { BeforeProviderRequestEvent } from '@mariozechner/pi-coding-agent';

// =============================================================================
// Types & State
// =============================================================================

export type OpenRouterSessionState = {
  sessionId: string;
};

// =============================================================================
// State Factory
// =============================================================================

export function formatSessionId(sessionId: string): string {
  if (sessionId.startsWith('pi:')) {
    return sessionId;
  }
  return `pi:${sessionId}`;
}

// =============================================================================
// Detection Logic
// =============================================================================

export function isOpenRouterRequest(event: BeforeProviderRequestEvent, _ctx: unknown): boolean {
  const ev = event as unknown as Record<string, unknown>;

  // Method 1: Check model string (e.g., "openrouter/anthropic/claude-3.5-sonnet")
  const payload = ev['payload'] as Record<string, unknown> | undefined;
  const model = String(payload?.['model'] ?? '');
  if (model.includes('openrouter/')) {
    return true;
  }

  // Method 2: Check baseUrl from context.model
  // OpenRouter models have baseUrl starting with https://openrouter.ai/api/v1
  const context = _ctx as Record<string, unknown>;
  const ctxModel = context['model'] as Record<string, unknown> | undefined;
  const baseUrl = ctxModel?.['baseUrl'] as string | undefined;
  if (baseUrl?.includes('openrouter.ai')) {
    return true;
  }

  // Method 3: Check for ZDR provider (Shopify routes to OpenRouter via ZDR)
  const provider = ev['provider'] as Record<string, unknown> | undefined;
  if (provider?.['zdr'] === true) {
    return true;
  }

  // Method 4: Check URL
  const url = String(
    (ev['url'] as string | undefined) ?? (ev['endpoint'] as string | undefined) ?? '',
  );
  if (url.includes('openrouter.ai')) {
    return true;
  }

  return false;
}
