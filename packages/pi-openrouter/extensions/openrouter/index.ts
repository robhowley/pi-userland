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
import { AccountOverlayComponent } from './account-overlay.js';
import { computeRollupStatus, sortKeys } from './account-format.js';
import { getAllKeys, getCurrentKey, getAccountCredits } from './account-client.js';
import type { KeyInfo } from './account-types.js';
import type { RollupStatus } from './account-types.js';
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
  pi.on('turn_end', async (event, ctx) => {
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
      const usage = (message as { usage?: unknown })['usage'] as
        | {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
            cost?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              total?: number;
            };
          }
        | undefined;
      if (!usage) return;

      // Extract model from the message
      const model = message['model'] as string | undefined;
      const responseModel = message['responseModel'] as string | undefined;
      const modelToLog = model || responseModel;

      // Calculate total cost from usage.cost.total
      const totalCost = usage.cost?.total;

      const localEvent = {
        id: crypto.randomUUID(),
        generationId: message['responseId'],
        sessionId: getCurrentSessionId(ctx),
        completedAt: new Date().toISOString(),
        model: modelToLog,
        promptTokens: usage.input,
        completionTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        cost: totalCost,
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

  pi.registerCommand('openrouter-account', {
    description: 'Show OpenRouter account and key health',
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      await showAccountOverlay(ctx);
    },
  });
}

async function showAccountOverlay(ctx: ExtensionContext) {
  let error: string | null = null;
  let keyInfo: KeyInfo[] | null = null;
  let credits: number | null = null;

  try {
    // Try to get all keys with management key
    const allKeys = await getAllKeys();

    if (allKeys && allKeys.length > 0) {
      keyInfo = allKeys;
    } else {
      // getAllKeys() returns null or empty array when management key isn't available
      // or when the API call fails with 403
      error = 'Key list unavailable - set OPENROUTER_MANAGEMENT_KEY for full key inventory.';

      // Fall back to current key only
      try {
        const currentKey = await getCurrentKey();
        if (currentKey) {
          keyInfo = [currentKey];
          // Clear the error since we successfully got current key
          error = null;
        } else {
          error = 'Failed to retrieve current key metadata. Check your API key permissions.';
        }
      } catch (err) {
        error = `Failed to retrieve current key: ${(err as Error).message}`;
      }
    }

    // Try to get account credits
    credits = await getAccountCredits();

    // Set error if we have no keys and no credits
    if (!keyInfo && !credits) {
      error =
        'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /openrouter-account.';
    }

    // Set error if we have credits but no keys
    if (!keyInfo && credits !== null) {
      error =
        error ||
        'Key information unavailable. Set OPENROUTER_MANAGEMENT_KEY for full key inventory.';
    }

    // Compute rollup status
    const rollupStatus = keyInfo
      ? computeRollupStatus(keyInfo)
      : { status: 'unavailable' as const };

    // Sort keys
    if (keyInfo) {
      const sortedKeys = sortKeys(keyInfo);
      keyInfo = sortedKeys;
    }

    await showAccountOverlayComponent(ctx, keyInfo, credits, rollupStatus, error);
  } catch (error_) {
    const err = error_ as Error;
    error =
      err instanceof AuthError
        ? 'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /openrouter-account.'
        : `API Error: ${err.message}`;

    // Try to get current key for overlay even on error
    try {
      const currentKey = await getCurrentKey();
      if (currentKey) {
        keyInfo = [currentKey];
      }
    } catch {
      // Ignore secondary errors
    }

    const rollupStatus = keyInfo
      ? computeRollupStatus(keyInfo)
      : { status: 'unavailable' as const };

    await showAccountOverlayComponent(ctx, keyInfo, credits, rollupStatus, error);
  }
}

async function showAccountOverlayComponent(
  ctx: ExtensionContext,
  keyInfo: KeyInfo[] | null,
  credits: number | null,
  rollupStatus: RollupStatus,
  error: string | null,
) {
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const overlayComponent = new AccountOverlayComponent(
        keyInfo,
        credits,
        rollupStatus,
        error,
        theme,
        done,
        () => _tui.requestRender(),
        ctx,
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
        wantsKeyRelease: false,
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
