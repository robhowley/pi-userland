import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { stopBackgroundRefresh } from './cache.js';
import { isOpenRouterRequest } from './session.js';
import { createSessionState, type SessionState } from './session-state.js';
import { writeLocalUsage, type LocalUsageEvent } from './local-usage.js';
import { loadCache, getCacheAgeMs, formatDuration } from './models/cache.js';
import { mapOpenRouterModels } from './models/mapper.js';
import { includeBuiltinRouterModels, isSyncEnabled } from './models/sync.js';
import { loadOpenRouterStatusBar } from './status-bar.js';

let sessionState: SessionState | null = null;
let sessionTrackingInstalled = false;

export interface StartupCacheState {
  info?: {
    count: number;
    age: string;
  };
  warning?: string;
}

export function initializeSessionState(): void {
  sessionState = createSessionState();
}

/**
 * Get the current OpenRouter session ID.
 * Returns a stable formatted session ID for the active Pi session.
 * @internal Exposed for testing
 */
export function getCurrentSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
  if (!sessionState) {
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
    const ev = event as Record<string, unknown>;
    const payload = ev['payload'] as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }

    const isOpenRouter = isOpenRouterRequest(event as BeforeProviderRequestEvent, ctx);
    if (!isOpenRouter) {
      return;
    }

    if ('session_id' in payload && payload['session_id'] !== undefined) {
      return;
    }

    return {
      ...payload,
      session_id: getCurrentSessionId(ctx),
    };
  } catch {
    return;
  }
}

export async function loadStartupCacheState(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
): Promise<StartupCacheState> {
  const startupState: StartupCacheState = {};

  if (!isSyncEnabled()) {
    return startupState;
  }

  const cache = await loadCache().catch(() => null);
  if (!cache?.models.length) {
    return startupState;
  }

  try {
    const { configs } = await mapOpenRouterModels(cache.models);
    const configsWithRouters = includeBuiltinRouterModels(configs);

    pi.registerProvider('openrouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'OPENROUTER_API_KEY',
      api: 'openai-completions',
      models: configsWithRouters,
      authHeader: true,
    });

    startupState.info = {
      count: configsWithRouters.length,
      age: formatDuration(getCacheAgeMs(cache)),
    };
  } catch (error) {
    startupState.warning = `OpenRouter: cached models found but failed to register: ${error instanceof Error ? error.message : String(error)}`;
  }

  return startupState;
}

export function installOpenRouterHooks(
  pi: Pick<ExtensionAPI, 'on'>,
  startupState: StartupCacheState,
): void {
  installSessionTaggingHook(pi);
  installLocalUsageHook(pi);
  installLifecycleHooks(pi, startupState);
}

function installSessionTaggingHook(pi: Pick<ExtensionAPI, 'on'>): void {
  if (sessionTrackingInstalled) {
    return;
  }

  sessionTrackingInstalled = true;
  pi.on('before_provider_request', (event, ctx) => {
    return addSessionIdToOpenRouterRequest(event as unknown, ctx);
  });
}

function installLocalUsageHook(pi: Pick<ExtensionAPI, 'on'>): void {
  pi.on('turn_end', (event, ctx) => {
    captureLocalUsage(event as unknown, ctx);
  });
}

function captureLocalUsage(event: unknown, ctx: ExtensionContext): void {
  try {
    const turnEvent = event as Record<string, unknown>;

    const message = turnEvent['message'] as Record<string, unknown> | undefined;
    if (!message) return;

    const openRouterEvent = {
      type: 'before_provider_request',
      payload: message,
      url: turnEvent['url'],
      endpoint: turnEvent['endpoint'],
    } as unknown as Parameters<typeof isOpenRouterRequest>[0];

    if (!isOpenRouterRequest(openRouterEvent, ctx)) return;

    const usage = (message as { usage?: unknown })['usage'] as
      | {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          cost?: {
            total?: number;
          };
        }
      | undefined;
    if (!usage) return;

    const model = message['model'] as string | undefined;
    const responseModel = message['responseModel'] as string | undefined;

    const localEvent: LocalUsageEvent = {
      id: crypto.randomUUID(),
      generationId: String(message['responseId'] ?? ''),
      sessionId: getCurrentSessionId(ctx),
      completedAt: new Date().toISOString(),
      model: model || responseModel || 'unknown',
      requests: 1,
      promptTokens: usage.input ?? 0,
      completionTokens: usage.output ?? 0,
      reasoningTokens: 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      cost: usage.cost?.total ?? 0,
    };

    void writeLocalUsage(localEvent)
      .then(() => refreshOpenRouterUsageStatus(ctx))
      .catch(() => {});
  } catch {
    // Fail open - silently ignore errors
  }
}

async function refreshOpenRouterUsageStatus(
  ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>,
): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const statusText = await loadOpenRouterStatusBar();
    if (statusText === null) {
      ctx.ui.setStatus('openrouter', undefined);
      return;
    }

    ctx.ui.setStatus('openrouter', ctx.ui.theme.fg('dim', statusText));
  } catch {
    ctx.ui.setStatus('openrouter', undefined);
  }
}

function installLifecycleHooks(
  pi: Pick<ExtensionAPI, 'on'>,
  startupState: StartupCacheState,
): void {
  pi.on('session_shutdown', () => {
    stopBackgroundRefresh();
    sessionState?.reset();
  });

  pi.on('session_start', (event, ctx) => {
    handleSessionStart(event as { reason: string }, ctx, startupState);
  });
}

function handleSessionStart(
  event: { reason: string },
  ctx: ExtensionContext,
  startupState: StartupCacheState,
): void {
  sessionState?.startSession(ctx);

  if (!ctx.hasUI) return;

  void refreshOpenRouterUsageStatus(ctx).catch(() => {});

  if (event.reason === 'startup' && startupState.info) {
    const notice = `OpenRouter: ${startupState.info.count} models loaded from cache (${startupState.info.age} old). Run /openrouter models-sync to refresh.`;
    ctx.ui.notify(notice, 'info');
  }

  if (event.reason === 'startup' && startupState.warning) {
    ctx.ui.notify(startupState.warning, 'warning');
  }
}
