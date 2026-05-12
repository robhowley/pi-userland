import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';
import { MS_PER_MINUTE } from './models/types.js';
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

// Import models sync
import {
  syncModels,
  getSyncState,
  isSyncEnabled,
  getSkipReasonsAsync,
  groupSkipReasons,
} from './models/sync.js';
import { loadCache, getCacheAgeMs, formatDuration } from './models/cache.js';

// Store the current session state for use in command handlers
let currentSessionState: OpenRouterSessionState | null = null;
let sessionTrackingInstalled = false;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format skipped models details for --skipped flag output.
 */
function formatSkippedDetails(
  skipCount: number,
  groupedReasons: Record<string, number>,
  skipReasons: Array<{ id: string; reason: string }>,
): string {
  if (skipCount === 0) {
    return '\n\nNo skipped models';
  }

  let details = `\n\nOpenRouter skipped models: ${skipCount}\n`;
  for (const [reason, count] of Object.entries(groupedReasons)) {
    details += `\n${count} ${reason}\n`;
    const modelsWithReason = skipReasons.filter((r) => r.reason === reason).map((r) => r.id);
    for (const id of modelsWithReason) {
      details += `- ${id}\n`;
    }
  }
  return details;
}

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
      // Include url/endpoint from turnEvent so isOpenRouterRequest can check them
      const isOpenRouter = isOpenRouterRequest(
        {
          type: 'before_provider_request',
          payload: message,
          url: turnEvent['url'],
          endpoint: turnEvent['endpoint'],
        } as unknown as Parameters<typeof isOpenRouterRequest>[0],
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

      const localEvent: LocalUsageEvent = {
        id: crypto.randomUUID(),
        generationId: String(message['responseId'] ?? ''),
        sessionId: getCurrentSessionId(ctx),
        completedAt: new Date().toISOString(),
        model: modelToLog ?? 'unknown',
        requests: 1,
        promptTokens: usage.input ?? 0,
        completionTokens: usage.output ?? 0,
        reasoningTokens: 0,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
        cost: totalCost ?? 0,
      };

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

  // ============== MODELS COMMANDS (subcommands of /openrouter) ==============

  // Single entry point with subcommands: /openrouter [usage|account|session|models-sync|models-status]
  pi.registerCommand('openrouter', {
    description: 'OpenRouter commands: usage, account, session, models-sync, models-status',
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ['usage', 'account', 'session', 'models-sync', 'models-status'];
      const items = subcommands
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      // Parse subcommand and flags
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || '';
      const flags = parts.slice(1).reduce(
        (acc, flag) => {
          acc[flag] = true;
          return acc;
        },
        {} as Record<string, boolean>,
      );

      switch (subcommand) {
        case 'usage': {
          startBackgroundRefresh();
          await showUsageOverlay(ctx, undefined);
          break;
        }
        case 'account': {
          await showAccountOverlay(ctx);
          break;
        }
        case 'session': {
          ctx.ui.notify(`OpenRouter session_id\n${getCurrentSessionId(ctx)}`, 'info');
          break;
        }
        case 'models-sync': {
          if (!isSyncEnabled()) {
            ctx.ui.notify(
              'OpenRouter model sync is disabled. Set openrouterModelSync: true in ~/.pi/agent/settings.json to enable.',
              'error',
            );
            return;
          }
          const result = await syncModels(ctx);

          // Display brief result using same color scheme as overlays
          if (!result.success) {
            let message = '';
            if (result.source === 'cache') {
              message = `OpenRouter models sync failed\n${result.registeredCount} registered from cache\nCache age: ${formatDuration(result.cacheAgeMs)}\nError: ${result.error}`;
            } else {
              message = `OpenRouter models unavailable\n0 registered\nError: ${result.error}`;
            }
            ctx.ui.notify(message, result.source === 'cache' ? 'warning' : 'error');
          } else {
            const message = `OpenRouter models synced\n${result.registeredCount} registered${result.skippedCount > 0 ? ` · ${result.skippedCount} skipped` : ''} · cache updated`;
            ctx.ui.notify(message, 'info');
          }
          break;
        }
        case 'models-status': {
          const state = getSyncState();
          const skipReasons = await getSkipReasonsAsync();
          const groupedReasons = groupSkipReasons(skipReasons);

          // Get real-time cache age from disk
          const cache = await loadCache();
          const cacheAgeMs = cache ? getCacheAgeMs(cache) : null;

          if (!state) {
            ctx.ui.notify('OpenRouter models: not synced', 'error');
          } else if (state.success) {
            const skipCount = skipReasons.length;
            let message = `OpenRouter models healthy\n${state.registeredCount} registered${skipCount > 0 ? ` · ${skipCount} skipped` : ''} · cache age: ${formatDuration(cacheAgeMs)}`;

            if (flags['--skipped']) {
              message += formatSkippedDetails(skipCount, groupedReasons, skipReasons);
            }
            ctx.ui.notify(message, 'info');
          } else if (state.source === 'cache') {
            const skipCount = skipReasons.length;
            let message = `OpenRouter models cached\n${state.registeredCount} registered${skipCount > 0 ? ` · ${skipCount} skipped` : ''}\nCache age: ${formatDuration(cacheAgeMs)}\nError: ${state.error}`;

            if (flags['--skipped']) {
              message += formatSkippedDetails(skipCount, groupedReasons, skipReasons);
            }
            ctx.ui.notify(message, 'warning');
          } else {
            ctx.ui.notify(`OpenRouter models broken\n0 registered\nError: ${state.error}`, 'error');
          }
          break;
        }
        default: {
          const available = ['usage', 'account', 'session', 'models-sync', 'models-status'];
          const message =
            available.length > 0
              ? `Available subcommands: ${available.join(', ')}${available.length > 1 ? '' : ''}`
              : 'No subcommands available';
          ctx.ui.notify(`OpenRouter subcommands\n${message}`, 'error');
          break;
        }
      }
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
    ? Math.round((Date.now() - lastFetchTimestamp) / MS_PER_MINUTE)
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
