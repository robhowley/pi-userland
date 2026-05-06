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
