import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';
import { MS_PER_MINUTE } from './models/types.js';
import {
  usageCache,
  startBackgroundRefresh,
  fetchAndAggregate,
  isRateLimitError,
} from './cache.js';
import { AuthError } from './client.js';
import { UsageOverlayComponent } from './overlay.js';
import { getCurrentSessionId } from './hooks.js';
import { AccountOverlayComponent } from './account-overlay.js';
import { computeRollupStatus, sortKeys } from './account-format.js';
import {
  getAllKeys,
  getCurrentKey,
  resolveCurrentKeyRelation,
  getAccountCredits,
} from './account-client.js';
import type { CurrentKeyRelation, KeyInfo, RollupStatus } from './account-types.js';
import {
  syncModels,
  getSyncState,
  isSyncEnabled,
  getSkipReasonsAsync,
  groupSkipReasons,
} from './models/sync.js';
import { loadCache, getCacheAgeMs, formatDuration } from './models/cache.js';
import { loadModelOverrides } from './models/overrides.js';
import { getSkipReasonHint } from './models/skip-hints.js';
import type { ModelOverridesFile } from './models/types.js';
import {
  handleModelOverrideSet,
  handleModelOverrideClear,
  handleModelOverrideList,
} from './models/override-commands.js';
import type { HandlerResult } from './api-key-commands.js';
import { handleApiKeyCreate, handleApiKeyDisable, handleApiKeyEnable } from './api-key-commands.js';

export const OPENROUTER_SUBCOMMANDS = [
  'usage',
  'account',
  'session',
  'models-sync',
  'models-status',
  'model-override-set',
  'model-override-clear',
  'model-override-list',
  'api-key-create',
] as const;

export function registerOpenRouterCommands(pi: Pick<ExtensionAPI, 'registerCommand'>): void {
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
      notifyCurrentSession(ctx);
    },
  });

  pi.registerCommand('openrouter-account', {
    description: 'Show OpenRouter account and key health',
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      await showAccountOverlay(ctx);
    },
  });

  pi.registerCommand('openrouter', {
    description: `OpenRouter commands: ${OPENROUTER_SUBCOMMANDS.join(', ')}`,
    getArgumentCompletions: getOpenRouterSubcommandCompletions,
    handler: async (args, ctx) => {
      await handleOpenRouterCommand(args, ctx);
    },
  });
}

function getOpenRouterSubcommandCompletions(prefix: string) {
  const items = OPENROUTER_SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(prefix)).map(
    (subcommand) => ({ value: subcommand, label: subcommand }),
  );
  return items.length > 0 ? items : null;
}

async function handleOpenRouterCommand(args: string, ctx: ExtensionContext): Promise<void> {
  const { subcommand, subcommandArgs, flags } = parseOpenRouterCommandArgs(args);

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
      notifyCurrentSession(ctx);
      break;
    }
    case 'models-sync': {
      await handleModelsSyncCommand(ctx);
      break;
    }
    case 'models-status': {
      await handleModelsStatusCommand(ctx, flags);
      break;
    }
    case 'model-override-set': {
      await handleModelOverrideSetCommand(subcommandArgs, ctx);
      break;
    }
    case 'model-override-clear': {
      await handleModelOverrideClearCommand(subcommandArgs, ctx);
      break;
    }
    case 'model-override-list': {
      await handleModelOverrideListCommand(subcommandArgs, ctx);
      break;
    }
    case 'api-key-create': {
      await handleApiKeyCreateCommand(subcommandArgs, ctx);
      break;
    }
    // Back-compat only: hidden from public help/completions in favor of /openrouter account toggle UX.
    case 'api-key-disable': {
      await handleApiKeyDisableCommand(subcommandArgs, ctx);
      break;
    }
    case 'api-key-enable': {
      await handleApiKeyEnableCommand(subcommandArgs, ctx);
      break;
    }
    default: {
      notifyUnknownSubcommand(ctx);
      break;
    }
  }
}

function parseOpenRouterCommandArgs(args: string): {
  subcommand: string;
  subcommandArgs: string;
  flags: Record<string, boolean>;
} {
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

  return { subcommand, subcommandArgs, flags };
}

function notifyCurrentSession(ctx: {
  sessionManager: { getSessionId(): string };
  ui: { notify(message: string, level: 'info'): void };
}): void {
  ctx.ui.notify(`OpenRouter session_id\n${getCurrentSessionId(ctx)}`, 'info');
}

async function handleModelsSyncCommand(ctx: ExtensionContext): Promise<void> {
  if (!isSyncEnabled()) {
    ctx.ui.notify(
      'OpenRouter model sync is disabled. Set openrouterModelSync: true in ~/.pi/agent/settings.json to enable.',
      'error',
    );
    return;
  }

  const result = await syncModels(ctx);
  if (!result.success) {
    let message = '';
    if (result.source === 'cache') {
      message = `OpenRouter models sync failed\n${result.registeredCount} registered from cache\nCache age: ${formatDuration(result.cacheAgeMs)}\nError: ${result.error}`;
    } else {
      message = `OpenRouter models unavailable\n0 registered\nError: ${result.error}`;
    }
    ctx.ui.notify(message, result.source === 'cache' ? 'warning' : 'error');
    return;
  }

  const message = `OpenRouter models synced\n${result.registeredCount} registered${result.skippedCount > 0 ? ` · ${result.skippedCount} skipped` : ''} · cache updated`;
  ctx.ui.notify(message, 'info');
}

async function handleModelsStatusCommand(
  ctx: ExtensionContext,
  flags: Record<string, boolean>,
): Promise<void> {
  const state = getSyncState();
  const skipReasons = await getSkipReasonsAsync();
  const groupedReasons = groupSkipReasons(skipReasons);

  const cache = await loadCache();
  const cacheAgeMs = cache ? getCacheAgeMs(cache) : null;

  if (!state && !cache) {
    ctx.ui.notify('OpenRouter models: not synced', 'error');
    return;
  }

  if (!state && cache) {
    const cachedCount = cache.models.length;
    const message = `OpenRouter models cached\n${cachedCount} models in cache · age: ${formatDuration(cacheAgeMs)}\nRun '/openrouter models-sync' to register models`;
    ctx.ui.notify(message, 'info');
    return;
  }

  if (state?.success) {
    const skipCount = skipReasons.length;
    let message = `OpenRouter models healthy\n${state.registeredCount} registered${skipCount > 0 ? ` · ${skipCount} skipped` : ''} · cache age: ${formatDuration(cacheAgeMs)}`;

    if (flags['--skipped']) {
      message += formatSkippedDetails(skipCount, groupedReasons, skipReasons);
    }
    ctx.ui.notify(message, 'info');
    return;
  }

  if (state?.source === 'cache') {
    const skipCount = skipReasons.length;
    let message = `OpenRouter models cached\n${state.registeredCount} registered${skipCount > 0 ? ` · ${skipCount} skipped` : ''}\nCache age: ${formatDuration(cacheAgeMs)}\nError: ${state.error}`;

    if (flags['--skipped']) {
      message += formatSkippedDetails(skipCount, groupedReasons, skipReasons);
    }
    ctx.ui.notify(message, 'warning');
    return;
  }

  ctx.ui.notify(`OpenRouter models broken\n0 registered\nError: ${state?.error}`, 'error');
}

async function handleModelOverrideSetCommand(
  subcommandArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  let userOverrides: ModelOverridesFile;
  try {
    userOverrides = await loadModelOverrides();
  } catch (error) {
    ctx.ui.notify(`Failed to load model overrides: ${getErrorMessage(error)}`, 'error');
    return;
  }

  const result = await handleModelOverrideSet(subcommandArgs, userOverrides);
  if (result.success) {
    ctx.ui.notify(result.message, 'info');
    if (result.modelId && ctx.model && result.modelId === ctx.model.id) {
      ctx.ui.notify(
        'Model configuration updated. Run /openrouter models-sync to apply changes to the current conversation.',
        'info',
      );
    }
    return;
  }

  ctx.ui.notify(result.message, 'error');
}

async function handleModelOverrideClearCommand(
  subcommandArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  let userOverrides: ModelOverridesFile;
  try {
    userOverrides = await loadModelOverrides();
  } catch (error) {
    ctx.ui.notify(`Failed to load model overrides: ${getErrorMessage(error)}`, 'error');
    return;
  }

  const result = await handleModelOverrideClear(subcommandArgs, userOverrides);
  if (result.success) {
    ctx.ui.notify(result.message, 'info');
    if (result.modelId && ctx.model && result.modelId === ctx.model.id) {
      ctx.ui.notify(
        'Model configuration updated. Run /openrouter models-sync to apply changes to the current conversation.',
        'info',
      );
    }
    return;
  }

  ctx.ui.notify(result.message, 'error');
}

async function handleModelOverrideListCommand(
  subcommandArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    const result = await handleModelOverrideList(subcommandArgs);
    ctx.ui.notify(result, 'info');
  } catch (error) {
    ctx.ui.notify(`Failed to load model overrides: ${getErrorMessage(error)}`, 'error');
  }
}

async function handleApiKeyCreateCommand(
  subcommandArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  const result = await handleApiKeyCreate(subcommandArgs);
  if (!result.success) {
    ctx.ui.notify(result.message, 'error');
    return;
  }

  if (result.secret) {
    await showApiKeySecretOverlay(ctx, result);
  }
  ctx.ui.notify(result.message, 'info');
}

async function handleApiKeyDisableCommand(
  subcommandArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  const result = await handleApiKeyDisable(subcommandArgs);
  ctx.ui.notify(result.message, result.success ? 'info' : 'error');
}

async function handleApiKeyEnableCommand(
  subcommandArgs: string,
  ctx: ExtensionContext,
): Promise<void> {
  const result = await handleApiKeyEnable(subcommandArgs);
  ctx.ui.notify(result.message, result.success ? 'info' : 'error');
}

async function showApiKeySecretOverlay(
  ctx: ExtensionContext,
  result: HandlerResult,
): Promise<void> {
  if (!result.secret) return;

  const lines = [
    'OpenRouter API key created',
    '',
    ...result.message
      .split('\n')
      .filter((line) => line !== 'OpenRouter API key created' && !line.startsWith('Secret shown')),
    '',
    'Secret (store now; shown once):',
    result.secret,
    '',
    'Press any key to close.',
  ];

  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => ({
      handleInput: () => {
        done();
      },
      render: (_width: number) =>
        lines.map((line, index) => (index === 0 ? theme.bold(line) : line)),
      invalidate: () => {},
      dispose: () => {},
      wantsKeyRelease: false,
    }),
    {
      overlay: true,
      overlayOptions: {
        width: 120,
      },
    },
  );
}

function notifyUnknownSubcommand(ctx: ExtensionContext): void {
  const message = `Available subcommands: ${OPENROUTER_SUBCOMMANDS.join(', ')}`;
  ctx.ui.notify(`OpenRouter subcommands\n${message}`, 'error');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSkippedDetails(
  skipCount: number,
  groupedReasons: Record<string, number>,
  skipReasons: Array<{ id: string; reason: string; hint?: string }>,
): string {
  if (skipCount === 0) {
    return '\n\nNo skipped models';
  }

  let details = `\n\nOpenRouter skipped models: ${skipCount}\n`;
  for (const [reason, count] of Object.entries(groupedReasons)) {
    details += `\n${count} ${reason}\n`;

    const hint =
      skipReasons.find((item) => item.reason === reason)?.hint ?? getSkipReasonHint(reason);
    if (hint) {
      details += `  suggestion: ${hint}\n`;
    }

    const modelsWithReason = skipReasons
      .filter((item) => item.reason === reason)
      .map((item) => item.id);
    for (const id of modelsWithReason) {
      details += `- ${id}\n`;
    }
  }
  return details;
}

async function showAccountOverlay(ctx: ExtensionContext) {
  let error: string | null = null;
  let keyInfo: KeyInfo[] | null = null;
  let credits: number | null = null;
  let canManageKeys = false;
  let currentKeyRelation: CurrentKeyRelation | undefined;

  try {
    const keyInventory = await getAllKeys();
    canManageKeys = keyInventory.canManageKeys;

    if (keyInventory.keys.length > 0) {
      keyInfo = keyInventory.keys;
      try {
        currentKeyRelation = await resolveCurrentKeyRelation(keyInfo);
      } catch {
        // Safe gating: disabling stays blocked until current-key identity is available.
      }
    } else if (keyInventory.degradedReason === 'management-unavailable') {
      error = 'Key list unavailable - set OPENROUTER_MANAGEMENT_KEY for full key inventory.';

      try {
        const currentKey = await getCurrentKey();
        if (currentKey) {
          keyInfo = [currentKey];
          error = null;
        } else {
          error = 'Failed to retrieve current key metadata. Check your API key permissions.';
        }
      } catch (err) {
        error = `Failed to retrieve current key: ${(err as Error).message}`;
      }
    }

    credits = await getAccountCredits();

    if (!keyInfo && !credits && keyInventory.degradedReason === 'missing-api-key') {
      error =
        'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /openrouter-account.';
    }

    if (!keyInfo && credits !== null && keyInventory.degradedReason === 'management-unavailable') {
      error =
        error ||
        'Key information unavailable. Set OPENROUTER_MANAGEMENT_KEY for full key inventory.';
    }

    const rollupStatus = keyInfo
      ? computeRollupStatus(keyInfo)
      : { status: 'unavailable' as const };

    if (keyInfo) {
      keyInfo = sortKeys(keyInfo);
    }

    await showAccountOverlayComponent(
      ctx,
      keyInfo,
      credits,
      rollupStatus,
      error,
      canManageKeys,
      currentKeyRelation,
    );
  } catch (error_) {
    const err = error_ as Error;
    error =
      err instanceof AuthError
        ? 'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /openrouter-account.'
        : `API Error: ${err.message}`;

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

    await showAccountOverlayComponent(ctx, keyInfo, credits, rollupStatus, error, false);
  }
}

async function showAccountOverlayComponent(
  ctx: ExtensionContext,
  keyInfo: KeyInfo[] | null,
  credits: number | null,
  rollupStatus: RollupStatus,
  error: string | null,
  canManageKeys: boolean,
  currentKeyRelation?: CurrentKeyRelation,
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
        canManageKeys,
        currentKeyRelation,
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
      const isRateLimited = isRateLimitError(state.lastError);
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
        staleSummary ? staleMinutesAgo : null,
      );
      return;
    }

    usageCache.set('usage', summary);
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
      staleSummary ? staleMinutesAgo : null,
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
