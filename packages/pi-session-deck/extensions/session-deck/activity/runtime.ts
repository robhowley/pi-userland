import { DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS } from './constants.js';
import { createToolFailureError, sanitizeActivityError } from './derive.js';
import { writeActivityRecord } from './writer.js';
import type {
  ActivityDiagnostic,
  ActivityMessageLike,
  ActivityRuntimeController,
  SessionActivityRecord,
} from './types.js';
import type { SessionManagerLike } from '../identity/types.js';

const ACTIVITY_RUNTIME_STATE_KEY = '__piSessionDeckActivityRuntimeState__';

export interface ActivityRuntimeConfig {
  runtimeId?: string;
  directory?: string;
  now?: () => Date;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  writeRecord?: (
    record: SessionActivityRecord,
    options: { directory?: string },
  ) => Promise<unknown>;
  onDiagnostic?: (diagnostic: ActivityDiagnostic) => void;
}

interface ActiveToolCall {
  toolName: string;
  startedAt: string;
}

interface ActivityRuntimeState {
  cachedActivity: SessionActivityRecord | null;
  activeStartPromise: Promise<ActivityRuntimeController> | null;
  activeTimer: ReturnType<typeof setInterval> | null;
  activeDirectory: string | undefined;
  activeClearInterval: typeof globalThis.clearInterval;
  runtimeId: string | undefined;
  sessionManager: SessionManagerLike | null;
  lastSeenSessionId: string | null;
  activeToolCalls: Map<string, ActiveToolCall>;
  hasActiveTurnError: boolean;
  runtimeDiagnostics: ActivityDiagnostic[];
  pendingMutation: Promise<void>;
}

type ActivityRuntimeGlobalState = typeof globalThis & {
  [ACTIVITY_RUNTIME_STATE_KEY]?: ActivityRuntimeState;
};

function getActivityRuntimeState(): ActivityRuntimeState {
  const globalState = globalThis as ActivityRuntimeGlobalState;
  const existingState = globalState[ACTIVITY_RUNTIME_STATE_KEY];
  if (existingState !== undefined) {
    return existingState;
  }

  const createdState: ActivityRuntimeState = {
    cachedActivity: null,
    activeStartPromise: null,
    activeTimer: null,
    activeDirectory: undefined,
    activeClearInterval: globalThis.clearInterval,
    runtimeId: undefined,
    sessionManager: null,
    lastSeenSessionId: null,
    activeToolCalls: new Map(),
    hasActiveTurnError: false,
    runtimeDiagnostics: [],
    pendingMutation: Promise.resolve(),
  };
  globalState[ACTIVITY_RUNTIME_STATE_KEY] = createdState;
  return createdState;
}

export async function ensureActivityRuntimeStarted(
  runtimeId: string,
  config: ActivityRuntimeConfig = {},
): Promise<ActivityRuntimeController> {
  const state = getActivityRuntimeState();
  if (state.activeStartPromise !== null) {
    return state.activeStartPromise;
  }

  state.runtimeId = runtimeId;
  state.activeDirectory = config.directory;
  state.sessionManager = null;
  state.runtimeDiagnostics = [];
  state.activeClearInterval = config.clearInterval ?? globalThis.clearInterval;

  state.activeStartPromise = (async () => {
    const controller: ActivityRuntimeController = {
      refreshActivity: async (source, sessionManager) =>
        runSerialized(state, async () => {
          if (sessionManager !== undefined) {
            state.sessionManager = sessionManager;
          }

          const sessionId = getCurrentSessionId(state);
          state.lastSeenSessionId = sessionId;
          state.activeToolCalls.clear();
          state.hasActiveTurnError = false;

          await writeSnapshot(
            state,
            config,
            createWaitingActivityRecord(
              getRequiredRuntimeId(state),
              sessionId,
              getNowIso(config),
              source,
            ),
          );
        }),
      recordMessageEnd: async (message: ActivityMessageLike) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          const current = getCurrentOrWaitingRecord(state, nowIso);

          if (message.role === 'user') {
            await writeSnapshot(state, config, {
              ...current,
              lastUserTurnAt: nowIso,
              lastEventAt: nowIso,
              activityUpdatedAt: nowIso,
              activitySource: 'message_end',
            });
            return;
          }

          if (message.role !== 'assistant') {
            return;
          }

          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            state.hasActiveTurnError = true;
            await writeSnapshot(state, config, {
              ...current,
              activityState: 'error',
              idle: false,
              busy: false,
              currentToolName: null,
              lastAssistantTurnAt: nowIso,
              lastEventAt: nowIso,
              lastError: sanitizeActivityError(
                message.errorMessage,
                message.stopReason === 'aborted' ? 'assistant aborted' : 'assistant error',
              ),
              lastErrorAt: nowIso,
              activityUpdatedAt: nowIso,
              activitySource: 'assistant_error',
            });
            return;
          }

          await writeSnapshot(state, config, {
            ...current,
            lastAssistantTurnAt: nowIso,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'message_end',
          });
        }),
      recordTurnStart: async () =>
        runSerialized(state, async () => {
          state.hasActiveTurnError = false;
          const nowIso = getNowIso(config);
          await writeSnapshot(state, config, {
            ...getCurrentOrWaitingRecord(state, nowIso),
            activityState: 'thinking',
            idle: false,
            busy: true,
            currentTurnStartedAt: nowIso,
            currentToolName: null,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'turn_start',
          });
        }),
      recordToolExecutionStart: async ({ toolCallId, toolName }) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          state.activeToolCalls.set(toolCallId, { toolName, startedAt: nowIso });

          const current = getCurrentOrWaitingRecord(state, nowIso);
          await writeSnapshot(state, config, {
            ...current,
            activityState: 'tool-running',
            idle: false,
            busy: true,
            currentTurnStartedAt: current.currentTurnStartedAt ?? nowIso,
            currentToolName: getMostRecentToolName(state.activeToolCalls),
            lastToolStartedAt: nowIso,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'tool_start',
          });
        }),
      recordToolExecutionEnd: async ({ toolCallId, toolName, isError }) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          state.activeToolCalls.delete(toolCallId);

          const current = getCurrentOrWaitingRecord(state, nowIso);
          const nextToolName = getMostRecentToolName(state.activeToolCalls);
          const hasActiveTurn = current.currentTurnStartedAt !== null;

          await writeSnapshot(state, config, {
            ...current,
            activityState:
              nextToolName !== null ? 'tool-running' : hasActiveTurn ? 'thinking' : 'waiting',
            idle: !hasActiveTurn,
            busy: hasActiveTurn,
            currentToolName: nextToolName,
            lastToolEndedAt: nowIso,
            lastEventAt: nowIso,
            lastError: isError ? createToolFailureError(toolName) : current.lastError,
            ...(isError ? { lastErrorAt: nowIso } : {}),
            activityUpdatedAt: nowIso,
            activitySource: 'tool_end',
          });
        }),
      recordTurnEnd: async () =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          state.activeToolCalls.clear();

          const current = getCurrentOrWaitingRecord(state, nowIso);
          await writeSnapshot(state, config, {
            ...current,
            activityState: state.hasActiveTurnError ? 'error' : 'waiting',
            idle: !state.hasActiveTurnError,
            busy: false,
            currentTurnStartedAt: null,
            currentToolName: null,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'turn_end',
          });
        }),
      getActivity: () => state.cachedActivity,
      isRunning: () => getActivityRuntimeState().activeTimer !== null,
    };

    if (state.activeTimer === null) {
      const setIntervalImpl = config.setInterval ?? globalThis.setInterval;
      state.activeTimer = setIntervalImpl(() => {
        void runSerialized(state, async () => {
          const runtimeId = getRequiredRuntimeId(state);
          if (runtimeId.length === 0) {
            return;
          }

          const nowIso = getNowIso(config);
          const sessionId = getCurrentSessionId(state);
          if (state.cachedActivity?.sessionId !== sessionId) {
            state.activeToolCalls.clear();
            state.hasActiveTurnError = false;
            await writeSnapshot(
              state,
              config,
              createWaitingActivityRecord(runtimeId, sessionId, nowIso, 'new'),
            );
            return;
          }

          const current = getCurrentOrWaitingRecord(state, nowIso);
          await writeSnapshot(state, config, {
            ...current,
            activityUpdatedAt: nowIso,
            activitySource: 'periodic',
          });
        });
      }, DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS);
      state.activeTimer.unref?.();
    }

    return controller;
  })();

  return state.activeStartPromise;
}

export function getActivityRuntimeDiagnostics(): ActivityDiagnostic[] {
  return [...getActivityRuntimeState().runtimeDiagnostics];
}

export async function stopActivityRuntime(): Promise<void> {
  const state = getActivityRuntimeState();
  if (state.activeTimer !== null) {
    state.activeClearInterval(state.activeTimer);
    state.activeTimer = null;
  }

  state.activeStartPromise = null;
  state.activeDirectory = undefined;
  state.activeClearInterval = globalThis.clearInterval;
  state.runtimeId = undefined;
  state.sessionManager = null;
  state.lastSeenSessionId = null;
  state.activeToolCalls.clear();
  state.hasActiveTurnError = false;
  state.runtimeDiagnostics = [];
  state.pendingMutation = Promise.resolve();
}

export async function resetActivityRuntimeForTests(): Promise<void> {
  const state = getActivityRuntimeState();
  await stopActivityRuntime();
  state.cachedActivity = null;
}

function createWaitingActivityRecord(
  runtimeId: string,
  sessionId: string | null,
  nowIso: string,
  source: NonNullable<SessionActivityRecord['activitySource']>,
): SessionActivityRecord {
  return {
    runtimeId,
    sessionId,
    activityState: 'waiting',
    idle: true,
    busy: false,
    currentTurnStartedAt: null,
    currentToolName: null,
    lastEventAt: nowIso,
    lastError: null,
    activityUpdatedAt: nowIso,
    activitySource: source,
  };
}

function getCurrentOrWaitingRecord(
  state: ActivityRuntimeState,
  nowIso: string,
): SessionActivityRecord {
  const runtimeId = getRequiredRuntimeId(state);
  const sessionId = getCurrentSessionId(state);

  if (state.cachedActivity !== null && state.cachedActivity.sessionId === sessionId) {
    state.lastSeenSessionId = sessionId;
    return state.cachedActivity;
  }

  state.lastSeenSessionId = sessionId;
  state.activeToolCalls.clear();
  state.hasActiveTurnError = false;
  return createWaitingActivityRecord(runtimeId, sessionId, nowIso, 'new');
}

function getCurrentSessionId(state: ActivityRuntimeState): string | null {
  const currentSessionId =
    safeCall(() => state.sessionManager?.getSessionId(), null) ?? state.lastSeenSessionId;
  return currentSessionId ?? null;
}

function getMostRecentToolName(activeToolCalls: Map<string, ActiveToolCall>): string | null {
  let mostRecent: ActiveToolCall | null = null;
  for (const activeToolCall of activeToolCalls.values()) {
    mostRecent = activeToolCall;
  }

  return mostRecent?.toolName ?? null;
}

function getRequiredRuntimeId(state: ActivityRuntimeState): string {
  return state.runtimeId ?? '';
}

function getNowIso(config: ActivityRuntimeConfig): string {
  return (config.now ?? (() => new Date()))().toISOString();
}

async function runSerialized<T>(
  state: ActivityRuntimeState,
  operation: () => Promise<T>,
): Promise<T> {
  const run = state.pendingMutation.then(operation, operation);
  state.pendingMutation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeSnapshot(
  state: ActivityRuntimeState,
  config: ActivityRuntimeConfig,
  record: SessionActivityRecord,
): Promise<void> {
  state.cachedActivity = record;

  try {
    await (config.writeRecord ?? writeActivityRecord)(record, {
      ...(state.activeDirectory === undefined ? {} : { directory: state.activeDirectory }),
    });
    state.runtimeDiagnostics = [];
  } catch (error) {
    const diagnostic: ActivityDiagnostic = {
      code: 'activity_write_error',
      message: `Failed to write activity record: ${getErrorMessage(error)}`,
      runtimeId: record.runtimeId,
    };
    state.runtimeDiagnostics = [diagnostic];
    try {
      config.onDiagnostic?.(diagnostic);
    } catch {
      // Fail-open on diagnostic sink errors.
    }
  }
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
