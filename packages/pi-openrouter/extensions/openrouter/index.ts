import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeProviderRequestEvent,
} from '@mariozechner/pi-coding-agent';
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
import { isOpenRouterRequest } from './session.js';
import { createSessionState, type SessionState } from './session-state.js';
import { writeLocalUsage, type LocalUsageEvent } from './local-usage.js';
import { AccountOverlayComponent } from './account-overlay.js';
import { computeRollupStatus, sortKeys } from './account-format.js';
import { getAllKeys, getCurrentKey, getAccountCredits } from './account-client.js';
import type { KeyInfo } from './account-types.js';
import type { RollupStatus } from './account-types.js';

// Import models sync
import {
  syncModels,
  getSyncState,
  isSyncEnabled,
  getSkipReasonsAsync,
  groupSkipReasons,
} from './models/sync.js';
import { loadCache, getCacheAgeMs, formatDuration } from './models/cache.js';
import { mapOpenRouterModels } from './models/mapper.js';
import {
  loadModelOverrides,
  saveModelOverrides,
  setModelOverride,
  removeModelOverride,
  getModelOverride,
  getOverrideModelIds,
  hasOverrides,
} from './models/overrides.js';
import type { UserModelOverride, ThinkingLevelMap, ModelOverridesFile } from './models/types.js';

// Store the session state manager (created per extension load, reset per Pi session)
let sessionState: SessionState | null = null;
let sessionTrackingInstalled = false;

// Store startup cache state for notifications
let startupCacheInfo: { count: number; age: string } | undefined;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format skipped models details for --skipped flag output.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * Get the current OpenRouter session ID.
 * Returns a stable formatted session ID for the active Pi session.
 * @internal Exposed for testing
 */
export function getCurrentSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
  if (!sessionState) {
    // Defensive: should never happen as sessionState is initialized in extension load
    sessionState = createSessionState();
  }
  return sessionState.getCurrentSessionId(ctx);
}

/**
 * Add session_id to OpenRouter requests before they are sent.
 * Returns modified payload with session_id, or undefined if no modification needed.
 */
export function addSessionIdToOpenRouterRequest(
  event: unknown,
  ctx: { sessionManager: { getSessionId(): string } },
): Record<string, unknown> | undefined {
  try {
    // Validate the payload exists
    const ev = event as unknown as Record<string, unknown>;
    const payload = ev['payload'] as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }

    // Check if this is an OpenRouter request
    const isOpenRouter = isOpenRouterRequest(event as unknown as BeforeProviderRequestEvent, ctx);
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
}

export default async function (pi: ExtensionAPI) {
  // Initialize session state manager
  sessionState = createSessionState();

  // Eager cache load on extension startup (before any sessions)
  startupCacheInfo = undefined;
  let startupCacheWarning: string | undefined;
  if (isSyncEnabled()) {
    const cache = await loadCache().catch(() => null);

    if (cache?.models.length) {
      try {
        const { configs } = await mapOpenRouterModels(cache.models);

        // Register models directly with Pi's OpenRouter provider
        pi.registerProvider('openrouter', {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'OPENROUTER_API_KEY',
          api: 'openai-completions',
          models: configs,
          authHeader: true,
        });

        // Store for session_start notification
        const age = formatDuration(getCacheAgeMs(cache));
        startupCacheInfo = { count: configs.length, age };
      } catch (error) {
        startupCacheInfo = undefined;
        startupCacheWarning = `OpenRouter: cached models found but failed to register: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  // Install before_provider_request hook once
  if (!sessionTrackingInstalled) {
    sessionTrackingInstalled = true;

    pi.on('before_provider_request', (event, ctx) => {
      return addSessionIdToOpenRouterRequest(event as unknown, ctx);
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
    // Reset session state for the next session
    if (sessionState) {
      sessionState.reset();
    }
  });

  // Notify on first session start after extension load
  pi.on('session_start', (event, ctx) => {
    // Update session state on each new session start
    // Only resets if raw session ID changes
    if (sessionState) {
      sessionState.startSession(ctx);
    }

    if (!ctx.hasUI) return;

    // Show a persistent status indicator
    if (startupCacheInfo) {
      const statusText = `OpenRouter ${startupCacheInfo.count} models`;
      ctx.ui.setStatus('openrouter', ctx.ui.theme.fg('dim', statusText));
    }

    // Show a one-time notification on startup
    if (event.reason === 'startup' && startupCacheInfo) {
      const notice = `OpenRouter: ${startupCacheInfo.count} models loaded from cache (${startupCacheInfo.age} old). Run /openrouter models-sync to refresh.`;
      ctx.ui.notify(notice, 'info');
    }

    if (event.reason === 'startup' && startupCacheWarning) {
      ctx.ui.notify(startupCacheWarning, 'warning');
    }
  });

  pi.registerCommand('openrouter-usage', {
    description: 'Show OpenRouter usage: caps, spend, burn rate, and model breakdowns',
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      startUsageBackgroundRefresh(ctx);
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
      const subcommands = [
        'usage',
        'account',
        'session',
        'models-sync',
        'models-status',
        'model-override-set',
        'model-override-clear',
        'model-override-list',
      ];
      const items = subcommands
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      // Parse subcommand and args
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || '';
      const subcommandArgs = parts.slice(1).join(' ').trim();
      const flags = parts.slice(1).reduce(
        (acc, flag) => {
          acc[flag] = true;
          return acc;
        },
        {} as Record<string, boolean>,
      );

      switch (subcommand) {
        case 'usage': {
          startUsageBackgroundRefresh(ctx);
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

          if (!state && !cache) {
            ctx.ui.notify('OpenRouter models: not synced', 'error');
          } else if (!state && cache) {
            // Cache exists but no in-memory state (new Pi session)
            const cachedCount = cache.models.length;
            const message = `OpenRouter models cached\n${cachedCount} models in cache · age: ${formatDuration(cacheAgeMs)}\nRun '/openrouter models-sync' to register models`;
            ctx.ui.notify(message, 'info');
          } else if (state?.success) {
            const skipCount = skipReasons.length;
            let message = `OpenRouter models healthy\n${state.registeredCount} registered${skipCount > 0 ? ` · ${skipCount} skipped` : ''} · cache age: ${formatDuration(cacheAgeMs)}`;

            if (flags['--skipped']) {
              message += formatSkippedDetails(skipCount, groupedReasons, skipReasons);
            }
            ctx.ui.notify(message, 'info');
          } else if (state?.source === 'cache') {
            const skipCount = skipReasons.length;
            let message = `OpenRouter models cached\n${state.registeredCount} registered${skipCount > 0 ? ` · ${skipCount} skipped` : ''}\nCache age: ${formatDuration(cacheAgeMs)}\nError: ${state.error}`;

            if (flags['--skipped']) {
              message += formatSkippedDetails(skipCount, groupedReasons, skipReasons);
            }
            ctx.ui.notify(message, 'warning');
          } else {
            ctx.ui.notify(
              `OpenRouter models broken\n0 registered\nError: ${state?.error}`,
              'error',
            );
          }
          break;
        }
        case 'model-override-set': {
          let userOverrides: ModelOverridesFile;
          try {
            userOverrides = await loadModelOverrides();
          } catch (error) {
            ctx.ui.notify(`Failed to load model overrides: ${getErrorMessage(error)}`, 'error');
            break;
          }

          const result = await handleModelOverrideSet(subcommandArgs, userOverrides);
          if (result.success) {
            ctx.ui.notify(result.message, 'info');
            // Notify if we just changed the currently active model
            if (result.modelId && ctx.model && result.modelId === ctx.model.id) {
              ctx.ui.notify(
                'Model configuration updated. Run /openrouter models-sync to apply changes to the current conversation.',
                'info',
              );
            }
          } else {
            ctx.ui.notify(result.message, 'error');
          }
          break;
        }
        case 'model-override-clear': {
          let userOverrides: ModelOverridesFile;
          try {
            userOverrides = await loadModelOverrides();
          } catch (error) {
            ctx.ui.notify(`Failed to load model overrides: ${getErrorMessage(error)}`, 'error');
            break;
          }

          const result = await handleModelOverrideClear(subcommandArgs, userOverrides);
          if (result.success) {
            ctx.ui.notify(result.message, 'info');
            // Notify if we just cleared the currently active model
            if (result.modelId && ctx.model && result.modelId === ctx.model.id) {
              ctx.ui.notify(
                'Model configuration updated. Run /openrouter models-sync to apply changes to the current conversation.',
                'info',
              );
            }
          } else {
            ctx.ui.notify(result.message, 'error');
          }
          break;
        }
        case 'model-override-list': {
          try {
            const result = await handleModelOverrideList(subcommandArgs);
            ctx.ui.notify(result, 'info');
          } catch (error) {
            ctx.ui.notify(`Failed to load model overrides: ${getErrorMessage(error)}`, 'error');
          }
          break;
        }
        default: {
          const available = [
            'usage',
            'account',
            'session',
            'models-sync',
            'models-status',
            'model-override-set',
            'model-override-clear',
            'model-override-list',
          ];
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

// =============================================================================
// Generic Model Override Handlers (Scoped Syntax)
// =============================================================================

interface HandlerResult {
  success: boolean;
  message: string;
  modelId?: string;
}

interface ScopedField {
  targetField: string;
  targetType: 'string' | 'number' | 'boolean';
}

/**
 * Scoped field name mapping: converts user-facing 'thinking.X' to internal 'thinkingLevelMap.X'
 * Also supports exact PiModelConfig field names for future extensibility.
 */
const SCOPED_FIELD_MAP: Record<string, ScopedField> = {
  // thinking.* shorthand - maps to thinkingLevelMap
  'thinking.off': { targetField: 'thinkingLevelMap.off', targetType: 'string' },
  'thinking.minimal': { targetField: 'thinkingLevelMap.minimal', targetType: 'string' },
  'thinking.low': { targetField: 'thinkingLevelMap.low', targetType: 'string' },
  'thinking.medium': { targetField: 'thinkingLevelMap.medium', targetType: 'string' },
  'thinking.high': { targetField: 'thinkingLevelMap.high', targetType: 'string' },
  'thinking.xhigh': { targetField: 'thinkingLevelMap.xhigh', targetType: 'string' },

  // exact field names (passthrough)
  'thinkingLevelMap.off': { targetField: 'thinkingLevelMap.off', targetType: 'string' },
  'thinkingLevelMap.minimal': { targetField: 'thinkingLevelMap.minimal', targetType: 'string' },
  'thinkingLevelMap.low': { targetField: 'thinkingLevelMap.low', targetType: 'string' },
  'thinkingLevelMap.medium': { targetField: 'thinkingLevelMap.medium', targetType: 'string' },
  'thinkingLevelMap.high': { targetField: 'thinkingLevelMap.high', targetType: 'string' },
  'thinkingLevelMap.xhigh': { targetField: 'thinkingLevelMap.xhigh', targetType: 'string' },

  // top-level fields (future extensibility)
  contextWindow: { targetField: 'contextWindow', targetType: 'number' },
  maxTokens: { targetField: 'maxTokens', targetType: 'number' },
  reasoning: { targetField: 'reasoning', targetType: 'boolean' },
};

/**
 * Parse a scoped assignment like "thinking.high=high" or "contextWindow=128000".
 */
export function parseScopedAssignment(
  assignment: string,
): { fullPath: string; value: unknown } | null {
  const eqIdx = assignment.indexOf('=');
  if (eqIdx === -1) return null;

  const scopedName = assignment.slice(0, eqIdx).trim();
  const rawValue = assignment.slice(eqIdx + 1).trim();

  const mapped = SCOPED_FIELD_MAP[scopedName];
  if (!mapped) return null;

  // Parse value by type
  let parsedValue: unknown;
  switch (mapped.targetType) {
    case 'string':
      // "null" -> null, otherwise string
      parsedValue = rawValue === 'null' ? null : rawValue;
      break;
    case 'number': {
      const num = parseInt(rawValue, 10);
      if (isNaN(num)) return null;
      parsedValue = num;
      break;
    }
    case 'boolean':
      if (rawValue !== 'true' && rawValue !== 'false') return null;
      parsedValue = rawValue === 'true';
      break;
    default:
      return null;
  }

  return { fullPath: mapped.targetField, value: parsedValue };
}

/**
 * Apply a nested value to an object using dot notation path.
 */
export function applyNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: unknown = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const currentRecord = current as Record<string, unknown>;
    if (
      !(key in currentRecord) ||
      typeof currentRecord[key] !== 'object' ||
      currentRecord[key] === null
    ) {
      currentRecord[key] = {};
    }
    current = currentRecord[key];
  }

  const finalKey = parts[parts.length - 1]!;
  (current as Record<string, unknown>)[finalKey] = value;
}

/**
 * Handle /openrouter model-override-set command.
 * Format: model-override-set <model-id> <field=value>...
 * Examples:
 *   /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max
 *   /openrouter model-override-set deepseek/deepseek-v4-pro contextWindow=128000
 */
export async function handleModelOverrideSet(
  args: string,
  userOverrides: ModelOverridesFile,
): Promise<HandlerResult> {
  const parts = args.trim().split(/\s+/).filter(Boolean);

  if (parts.length < 1) {
    return {
      success: false,
      message:
        'Usage: /openrouter model-override-set <model-id> <field=value>...\nExample: /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max',
    };
  }

  const modelId = parts[0];

  if (!modelId) {
    return {
      success: false,
      message:
        'Usage: /openrouter model-override-set <model-id> <field=value>...\nExample: /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max',
    };
  }

  // Validate model ID format (should be provider/model)
  if (!modelId.includes('/')) {
    return {
      success: false,
      message: `Invalid model ID format: "${modelId}"\nExpected format: provider/model (e.g., "deepseek/deepseek-v4-pro")`,
    };
  }

  // Build override incrementally from assignments
  const override: UserModelOverride = {};
  const assignments = parts.slice(1).filter((p) => !p.startsWith('--'));

  for (const assignment of assignments) {
    const parsed = parseScopedAssignment(assignment);
    if (!parsed) {
      return {
        success: false,
        message: `Invalid assignment: "${assignment}"\nExpected format: field=value (e.g., thinking.high=high or contextWindow=128000)\nSee available fields with /openrouter model-override-list --fields`,
      };
    }
    applyNestedValue(override as Record<string, unknown>, parsed.fullPath, parsed.value);
  }

  // If no assignments provided, error out
  if (Object.keys(override).length === 0) {
    return {
      success: false,
      message:
        'No field assignments provided.\nUsage: /openrouter model-override-set <model-id> field=value [field=value]...\nExample: /openrouter model-override-set deepseek/deepseek-v4-pro thinking.high=high thinking.xhigh=max',
    };
  }

  // Update overrides file
  const updatedOverrides = setModelOverride(userOverrides, modelId, override);
  try {
    await saveModelOverrides(updatedOverrides);
  } catch (error) {
    return {
      success: false,
      message: `Failed to save overrides for ${modelId}: ${getErrorMessage(error)}`,
    };
  }

  const savedOverride = updatedOverrides.overrides[modelId] as UserModelOverride;

  // Format success message
  const lines: string[] = [`Saved overrides for ${modelId}:`];
  for (const [key, val] of Object.entries(savedOverride)) {
    if (key === 'thinkingLevelMap' && val) {
      lines.push('  thinkingLevelMap:');
      for (const [level, mapped] of Object.entries(val as ThinkingLevelMap)) {
        lines.push(`    ${level}: ${mapped === null ? 'null' : mapped}`);
      }
    } else {
      lines.push(`  ${key}: ${val}`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
    modelId,
  };
}

/**
 * Handle /openrouter model-override-clear command.
 */
export async function handleModelOverrideClear(
  args: string,
  userOverrides: ModelOverridesFile,
): Promise<HandlerResult> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const modelId = parts[0];

  if (!modelId) {
    return {
      success: false,
      message: 'Usage: /openrouter model-override-clear <model-id>',
    };
  }

  if (!modelId.includes('/')) {
    return {
      success: false,
      message: `Invalid model ID format: "${modelId}"\nExpected format: provider/model`,
    };
  }

  const existing = getModelOverride(userOverrides, modelId);
  if (!existing) {
    return {
      success: false,
      message: `No overrides found for ${modelId}`,
    };
  }

  const updatedOverrides = removeModelOverride(userOverrides, modelId);
  try {
    await saveModelOverrides(updatedOverrides);
  } catch (error) {
    return {
      success: false,
      message: `Failed to clear overrides for ${modelId}: ${getErrorMessage(error)}`,
    };
  }

  return {
    success: true,
    message: `Cleared all overrides for ${modelId}`,
    modelId,
  };
}

/**
 * Handle /openrouter model-override-list command.
 */
export async function handleModelOverrideList(args: string): Promise<string> {
  const userOverrides = await loadModelOverrides();
  const modelId = args.trim();

  // List available fields if --fields flag
  if (modelId === '--fields') {
    const fields = Object.keys(SCOPED_FIELD_MAP)
      .map(
        (k) => `  ${k}: ${SCOPED_FIELD_MAP[k]!.targetField} (${SCOPED_FIELD_MAP[k]!.targetType})`,
      )
      .join('\n');
    return `Available override fields:\n${fields}`;
  }

  if (!hasOverrides(userOverrides)) {
    return 'No model overrides configured.\nUse /openrouter model-override-set to add overrides.';
  }

  if (modelId) {
    // Show specific model
    const override = getModelOverride(userOverrides, modelId);
    if (!override) {
      return `No overrides configured for ${modelId}`;
    }

    const lines: string[] = [`Overrides for ${modelId}:`];
    for (const [key, val] of Object.entries(override)) {
      if (key === 'thinkingLevelMap' && val) {
        lines.push('  thinkingLevelMap:');
        for (const [level, mapped] of Object.entries(val as ThinkingLevelMap)) {
          lines.push(`    ${level}: ${mapped === null ? 'null' : mapped}`);
        }
      } else {
        lines.push(`  ${key}: ${val}`);
      }
    }
    return lines.join('\n');
  }

  // List all overrides
  const modelIds = getOverrideModelIds(userOverrides);
  const lines: string[] = [`${modelIds.length} model(s) with overrides:`];
  for (const id of modelIds) {
    const override = getModelOverride(userOverrides, id);
    if (override?.thinkingLevelMap && Object.keys(override.thinkingLevelMap).length > 0) {
      const tlm = Object.entries(override.thinkingLevelMap)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      lines.push(`  ${id}${tlm ? ` [${tlm}]` : ''}`);
    } else {
      lines.push(`  ${id}`);
    }
  }
  lines.push('\nUse /openrouter model-override-list <model-id> for details');
  return lines.join('\n');
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

function startUsageBackgroundRefresh(ctx: ExtensionContext): void {
  startBackgroundRefresh({
    onFailure: (state) => {
      if (!ctx.hasUI || !state.lastError) return;

      const isPersistent = state.consecutiveFailures >= 4;
      const isRateLimited = state.lastError.toLowerCase().includes('rate limit');
      if (!isPersistent && !isRateLimited) return;

      const staleSuffix = state.status === 'stale' ? '\nShowing last successful usage data.' : '';
      ctx.ui.notify(
        `OpenRouter usage refresh ${state.status}\n${state.lastError}${staleSuffix}`,
        'warning',
      );
    },
  });
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

  const staleSummary = usageCache.get('usage', { allowStale: true });
  const staleFetchTimestamp = usageCache.getTimestamp('usage', { allowStale: true });
  const staleMinutesAgo = staleFetchTimestamp
    ? Math.round((Date.now() - staleFetchTimestamp) / MS_PER_MINUTE)
    : null;

  let error: string | null = null;
  let summary: UsageSummary | null = null;

  try {
    summary = await fetchAndAggregate();
    if (!summary) {
      error =
        'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /usage.';
      await showOverlay(
        ctx,
        staleSummary ?? null,
        staleSummary ? `${error}\nShowing last successful usage data.` : error,
        staleSummary ? staleMinutesAgo : 0,
      );
      return;
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
    await showOverlay(
      ctx,
      staleSummary ?? null,
      staleSummary ? `${error}\nShowing last successful usage data.` : error,
      staleSummary ? staleMinutesAgo : cachedMinutesAgo || 0,
    );
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
