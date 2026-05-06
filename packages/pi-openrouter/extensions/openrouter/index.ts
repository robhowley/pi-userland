import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';
import {
  usageCache,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  fetchAndAggregate,
} from './cache.js';
import { AuthError } from './client.js';
import { UsageOverlayComponent } from './overlay.js';
import { formatSessionId, isOpenRouterRequest, type OpenRouterSessionState } from './session.js';
import { writeLocalUsage, type LocalUsageEvent } from './local-usage.js';
import crypto from 'node:crypto';

// Store the current session state for use in command handlers
let currentSessionState: OpenRouterSessionState | null = null;
let sessionTrackingInstalled = false;

// =============================================================================
// Session State Management
// =============================================================================

function getCurrentSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
  if (currentSessionState) {
    return currentSessionState.sessionId;
  }

  try {
    const sessionId = ctx.sessionManager.getSessionId();
    let formattedSessionId: string;
    if (sessionId && sessionId !== '') {
      formattedSessionId = formatSessionId(sessionId);
    } else {
      formattedSessionId = formatSessionId(crypto.randomUUID());
    }

    currentSessionState = { sessionId: formattedSessionId };
    return formattedSessionId;
  } catch {
    // Generate fallback on any error
    const fallbackId = formatSessionId(crypto.randomUUID());
    currentSessionState = { sessionId: fallbackId };
    return fallbackId;
  }
}

export default function (pi: ExtensionAPI) {
  // Install before_provider_request hook once
  if (!sessionTrackingInstalled) {
    sessionTrackingInstalled = true;
    pi.on('before_provider_request', (event, ctx) => {
      try {
        // Validate the payload exists
        const ev = event as unknown as Record<string, unknown>;
        const payload = ev['payload'] as Record<string, unknown> | undefined;
        if (!payload) {
          return;
        }

        // Check if this is an OpenRouter request
        const isOpenRouter = isOpenRouterRequest(event, ctx);
        if (!isOpenRouter) {
          return;
        }

        // Do not overwrite existing session_id
        if ('session_id' in payload && payload['session_id'] !== undefined) {
          return;
        }

        // Add session_id to the payload (OpenRouter-specific field)
        return {
          ...payload,
          session_id: getCurrentSessionId(ctx),
        };
      } catch {
        // Fail open - silently ignore errors
        return;
      }
    });
  }

  // Hook turn_end to capture completed OpenRouter turns for local logging
  pi.on('turn_end', (event, ctx) => {
    try {
      const turnEvent = event as unknown as Record<string, unknown>;
      const message = turnEvent['message'] as Record<string, unknown> | undefined;
      if (!message) return;

      // Check if this is an OpenRouter request based on the message content/model
      const isOpenRouter = isOpenRouterRequest(
        { type: 'before_provider_request', payload: message } as unknown as Parameters<
          typeof isOpenRouterRequest
        >[0],
        ctx,
      );
      if (!isOpenRouter) return;

      // Check if the message has usage data
      const usage = (message as { usage?: unknown })['usage'];
      if (!usage) return;

      // Extract cost from headers if available
      const headers = (message as { headers?: Record<string, string> })['headers'];
      const cost = headers?.['x-cost'] ? parseFloat(headers['x-cost']) : undefined;

      // Extract provider from headers (e.g., "ionstream/fp8")
      const provider = headers?.['x-provider'];

      // Extract model from the message payload
      const payload = (message as { payload?: Record<string, unknown> })['payload'];
      const model = payload?.['model'] as string | undefined;

      // Extract token usage from usage data
      const usageData = usage as {
        input?: number;
        output?: number;
        reasoning?: number;
        total?: number;
      };

      const localEvent = {
        id: crypto.randomUUID(),
        sessionId: getCurrentSessionId(ctx),
        completedAt: new Date().toISOString(),
        requests: 1,
        model: model as string | undefined,
        provider: (provider && provider !== 'openrouter' ? provider : undefined) as
          | string
          | undefined,
        promptTokens: usageData.input as number | undefined,
        completionTokens: usageData.output as number | undefined,
        reasoningTokens: usageData.reasoning as number | undefined,
        cost: cost as number | undefined,
        estimated: cost === undefined,
      } as LocalUsageEvent;

      // Write to local JSONL - fail open (don't throw)
      writeLocalUsage(localEvent).catch(() => {});
    } catch {
      // Fail open - silently ignore errors
    }
  });

  pi.on('session_shutdown', () => {
    stopBackgroundRefresh();
  });

  pi.registerCommand('openrouter-usage', {
    description: 'Show OpenRouter usage: caps, spend, burn rate, and model breakdowns',
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      startBackgroundRefresh();
      const subcommand = args.trim() || undefined;
      await showUsageOverlay(ctx, subcommand);
    },
  });

  pi.registerCommand('openrouter-session', {
    description: 'Show the current OpenRouter session ID for request grouping',
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      const idToShow = getCurrentSessionId(ctx);
      ctx.ui.notify(`OpenRouter session_id\n${idToShow}`, 'info');
    },
  });
}

async function showUsageOverlay(ctx: ExtensionContext, _subcommand?: string) {
  const cachedSummary = usageCache.get('usage');
  const lastFetchTimestamp = usageCache.getTimestamp('usage');
  const cachedMinutesAgo = lastFetchTimestamp
    ? Math.round((Date.now() - lastFetchTimestamp) / 60000)
    : null;

  if (cachedSummary) {
    await showOverlay(ctx, cachedSummary, null, cachedMinutesAgo);
    return;
  }

  let error: string | null = null;
  let summary: UsageSummary | null = null;

  try {
    summary = await fetchAndAggregate();
    if (!summary) {
      error =
        'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /usage.';
    } else {
      usageCache.set('usage', summary);
    }

    await showOverlay(ctx, summary, error, 0);
  } catch (error_) {
    const err = error_ as Error;
    error =
      err instanceof AuthError
        ? 'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /usage.'
        : `API Error: ${err.message}`;
    await showOverlay(ctx, null, error, cachedMinutesAgo || 0);
  }
}

async function showOverlay(
  ctx: ExtensionContext,
  summary: UsageSummary | null,
  error: string | null,
  cachedMinutesAgo: number | null,
) {
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const overlayComponent = new UsageOverlayComponent(
        summary,
        error,
        cachedMinutesAgo,
        theme,
        done,
        () => _tui.requestRender(),
      );

      return {
        handleInput: (data: string) => {
          overlayComponent.handleInput(data);
          _tui.requestRender();
        },
        render: (width: number) => overlayComponent.render(width),
        invalidate: () => overlayComponent.invalidate(),
        dispose: () => {
          overlayComponent.dispose();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: 100,
      },
    },
  );
}
