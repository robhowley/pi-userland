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
  const payload = ev['payload'] as Record<string, unknown> | undefined;

  // Method 1: Check if provider is explicitly "openrouter" (Pi coding agent first-class)
  // Provider could be in event.provider, event.payload.provider, as string or object with name
  const eventProvider = ev['provider'];
  const payloadProvider = payload?.['provider'];
  const providerName =
    typeof eventProvider === 'string'
      ? eventProvider
      : typeof payloadProvider === 'string'
        ? payloadProvider
        : (eventProvider as Record<string, unknown> | undefined)?.['name'] ??
          (payloadProvider as Record<string, unknown> | undefined)?.['name'];
  if (providerName === 'openrouter') {
    return true;
  }

  // Method 2: Check model string (e.g., "openrouter/anthropic/claude-3.5-sonnet")
  const model = String(payload?.['model'] ?? '');
  if (model.includes('openrouter/')) {
    return true;
  }

  // Method 3: Check baseUrl from context.model
  // OpenRouter models have baseUrl starting with https://openrouter.ai/api/v1
  const context = _ctx as Record<string, unknown>;
  const ctxModel = context['model'] as Record<string, unknown> | undefined;
  const baseUrl = ctxModel?.['baseUrl'] as string | undefined;
  if (baseUrl?.includes('openrouter.ai')) {
    return true;
  }

  // Method 4: Check for ZDR provider (Shopify routes to OpenRouter via ZDR)
  const provider = ev['provider'] as Record<string, unknown> | undefined;
  if (provider?.['zdr'] === true) {
    return true;
  }

  // Method 5: Check URL (fallback for events where provider info is missing)
  const url = String(
    (ev['url'] as string | undefined) ?? (ev['endpoint'] as string | undefined) ?? '',
  );
  if (url.includes('openrouter.ai')) {
    return true;
  }

  return false;
}
