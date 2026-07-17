import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ensureActivityRuntimeStarted, type ActivityRuntimeConfig } from './activity/runtime.js';
import { SESSION_DECK_COMMAND_NAME } from './presence/constants.js';
import { registerSessionDeckCommand, type PresenceCommandAPI } from './identity/command.js';
import {
  ensurePresenceRuntimeStarted,
  type PresenceRuntimeController,
} from './presence/runtime.js';
import { ensureIdentityRuntimeStarted, stopIdentityRuntime } from './identity/runtime.js';
import { createSetStatusMirror } from './chips/mirror.js';
import {
  normalizeSessionHeaderMetadata,
  normalizeSessionStartMetadata,
} from './identity/metadata.js';
import { collectSessionTerminalMetadata } from './identity/terminal-collect.js';
import {
  collectRuntimeSignalsMetadata,
  publishDeckRuntimeEnv,
} from './identity/runtime-signals.js';
import type {
  SessionManagerLike,
  SessionRuntimeSignalsMetadata,
  SessionTerminalMetadata,
} from './identity/types.js';

interface SessionStartContext {
  mode?: string;
  hasUI?: boolean;
  cwd?: string;
  model?: {
    id?: string;
    provider?: string;
    reasoning?: unknown;
  } | null;
  getContextUsage?: () => {
    percent?: number | null;
    contextWindow?: number | null;
  } | null;
  sessionManager?: {
    getSessionId: () => string | null;
    getSessionFile: () => string | null;
    getEntries?: () => unknown[];
    getSessionName?: () => string | null;
    getCwd?: () => string;
    getHeader?: () => unknown;
  };
  ui: {
    setStatus: (key: string, text: string | undefined) => void;
  };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  registerSessionDeckCommand(pi as unknown as PresenceCommandAPI);
  const statusMirror = createSetStatusMirror();

  function on<TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => Promise<void> | void,
  ): void {
    (
      pi.on as unknown as (
        eventName: string,
        eventHandler: (...eventArgs: TArgs) => Promise<void> | void,
      ) => void
    )(event, handler);
  }

  on(
    'session_start',
    async (event: { reason: string; previousSessionFile?: string }, ctx: SessionStartContext) => {
      const presenceRuntime = await ensurePresenceRuntimeStarted();
      const [terminal, runtimeSignals] = await Promise.all([
        collectSessionTerminalMetadata(),
        collectRuntimeSignalsMetadata(),
      ]);
      const sessionManager = createSessionManager(ctx, event, terminal, runtimeSignals);

      // Install setStatus wrapper before session-deck sets its own status
      statusMirror.install(ctx.ui);
      statusMirror.reconfigure({
        runtimeId: presenceRuntime.runtime.runtimeId,
        getSessionId: sessionManager.getSessionId,
      });

      ctx.ui.setStatus(SESSION_DECK_COMMAND_NAME, getPresenceStartupStatus(presenceRuntime));

      const identityRuntime = await ensureIdentityRuntimeStarted(presenceRuntime.runtime.runtimeId);
      const activityRuntime = await ensureActivityRuntimeStarted(presenceRuntime.runtime.runtimeId);

      await identityRuntime.refreshIdentity(event.reason, sessionManager);
      publishDeckRuntimeEnv({
        runtimeId: presenceRuntime.runtime.runtimeId,
        sessionId: sessionManager.getSessionId(),
        sessionFile: sessionManager.getSessionFile(),
        startedAt: presenceRuntime.runtime.startedAt,
      });
      await activityRuntime.refreshActivity(
        event.reason === 'new' ? 'new' : 'startup',
        sessionManager,
      );
    },
  );

  on('message_end', async (event: { message?: unknown }) => {
    const activityRuntime = await ensureActivityRuntime();
    await activityRuntime.recordMessageEnd(getActivityMessage(event));
  });

  on('turn_start', async (_event: unknown) => {
    const activityRuntime = await ensureActivityRuntime();
    await activityRuntime.recordTurnStart();
  });

  on('tool_execution_start', async (event: { toolCallId?: unknown; toolName?: unknown }) => {
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
    const activityRuntime = await ensureActivityRuntime();
    await activityRuntime.recordToolExecutionStart({ toolCallId, toolName });
  });

  on(
    'tool_execution_end',
    async (event: { toolCallId?: unknown; toolName?: unknown; isError?: unknown }) => {
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
      const isError = event.isError === true;
      const activityRuntime = await ensureActivityRuntime();
      await activityRuntime.recordToolExecutionEnd({ toolCallId, toolName, isError });
    },
  );

  on('turn_end', async (_event: unknown) => {
    const activityRuntime = await ensureActivityRuntime();
    await activityRuntime.recordTurnEnd();
  });

  on('session_shutdown', async () => {
    await statusMirror.clearTracked();
    await stopIdentityRuntime();
  });

  await ensurePresenceRuntimeStarted();
}

async function ensureActivityRuntime(
  config: ActivityRuntimeConfig = {},
): Promise<Awaited<ReturnType<typeof ensureActivityRuntimeStarted>>> {
  const presenceRuntime = await ensurePresenceRuntimeStarted();
  return ensureActivityRuntimeStarted(presenceRuntime.runtime.runtimeId, config);
}

function createSessionManager(
  ctx: SessionStartContext,
  event: { reason: string; previousSessionFile?: string },
  terminal: SessionTerminalMetadata | undefined,
  runtimeSignals: SessionRuntimeSignalsMetadata,
): SessionManagerLike {
  const sessionStart = normalizeSessionStartMetadata({
    reason: event.reason,
    previousSessionFile: event.previousSessionFile,
    mode: ctx.mode,
    hasUI: ctx.hasUI,
  });
  return {
    getSessionId: () => ctx.sessionManager?.getSessionId() ?? null,
    getSessionFile: () => ctx.sessionManager?.getSessionFile() ?? null,
    getSessionName: () => ctx.sessionManager?.getSessionName?.(),
    getCwd: () => ctx.sessionManager?.getCwd?.() ?? ctx.cwd,
    getSessionStart: () => sessionStart,
    getHeader: () => normalizeSessionHeaderMetadata(ctx.sessionManager?.getHeader?.()) ?? null,
    getTerminal: () => terminal,
    getRuntimeSignals: () => runtimeSignals,
  };
}

function getActivityMessage(event: { message?: unknown }): {
  role?: string;
  stopReason?: string;
  errorMessage?: string | null;
} {
  const message = event.message;
  if (!isObject(message)) {
    return {};
  }

  return {
    ...(typeof message['role'] === 'string' ? { role: message['role'] } : {}),
    ...(typeof message['stopReason'] === 'string' ? { stopReason: message['stopReason'] } : {}),
    ...(typeof message['errorMessage'] === 'string'
      ? { errorMessage: message['errorMessage'] }
      : {}),
  };
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function getPresenceStartupStatus(runtime: PresenceRuntimeController): string | undefined {
  if (runtime.startup.state === 'healthy') {
    return undefined;
  }

  return `${SESSION_DECK_COMMAND_NAME} degraded: ${runtime.startup.diagnostic.message}`;
}
