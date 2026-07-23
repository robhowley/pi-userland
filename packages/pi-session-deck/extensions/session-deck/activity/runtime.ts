import { DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS, DEFAULT_ACTIVITY_THRESHOLDS } from './constants.js';
import { createToolFailureError, sanitizeActivityError } from './derive.js';
import { writeActivityRecord } from './writer.js';
import type {
  ActivityDiagnostic,
  ActivityInputSource,
  ActivityInputSummary,
  ActivityMessageLike,
  ActivityRuntimeController,
  ActivityToolWindow,
  SessionActivityRecord,
  SessionCompactionReason,
} from './types.js';
import type { SessionManagerLike } from '../identity/types.js';

const ACTIVITY_RUNTIME_STATE_KEY = '__piSessionDeckActivityRuntimeState__';
const ACTIVITY_RUNTIME_CONTROLLER_API_VERSION = 2;
const MAX_RECENT_TOOL_WINDOWS = 20;
const RECENT_TOOL_WINDOW_MAX_AGE_MS = 15 * 60 * 1000;

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
  inputSummary: ActivityInputSummary;
  recentToolWindows: ActivityToolWindow[];
  lastToolUpdateWrittenAtMs: number | null;
  hasActiveTurnError: boolean;
  runtimeDiagnostics: ActivityDiagnostic[];
  pendingMutation: Promise<void>;
  compactionToken: number;
  compactionAbortCleanup: (() => void) | null;
}

type ActivityRuntimeGlobalState = typeof globalThis & {
  [ACTIVITY_RUNTIME_STATE_KEY]?: ActivityRuntimeState;
};

function getActivityRuntimeState(): ActivityRuntimeState {
  const globalState = globalThis as ActivityRuntimeGlobalState;
  const existingState = globalState[ACTIVITY_RUNTIME_STATE_KEY];
  if (existingState !== undefined) {
    migrateActivityRuntimeState(existingState);
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
    inputSummary: {},
    recentToolWindows: [],
    lastToolUpdateWrittenAtMs: null,
    hasActiveTurnError: false,
    runtimeDiagnostics: [],
    pendingMutation: Promise.resolve(),
    compactionToken: 0,
    compactionAbortCleanup: null,
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
    const controller = await state.activeStartPromise;
    if (hasCurrentActivityRuntimeControllerApi(controller)) {
      return controller;
    }

    stopActivityRuntimeTimer(state);
    state.activeStartPromise = null;
  }

  state.runtimeId = runtimeId;
  state.activeDirectory = config.directory;
  state.sessionManager = null;
  state.runtimeDiagnostics = [];
  state.activeClearInterval = config.clearInterval ?? globalThis.clearInterval;

  state.activeStartPromise = (async () => {
    const controller = {
      refreshActivity: async (source, sessionManager) =>
        runSerialized(state, async () => {
          if (sessionManager !== undefined) {
            state.sessionManager = sessionManager;
          }

          const sessionId = getCurrentSessionId(state);
          state.lastSeenSessionId = sessionId;
          resetCompactionLifecycle(state);
          state.activeToolCalls.clear();
          state.inputSummary = {};
          state.recentToolWindows = [];
          state.lastToolUpdateWrittenAtMs = null;
          state.hasActiveTurnError = false;

          await writeSnapshot(
            state,
            config,
            createIdleActivityRecord(
              getRequiredRuntimeId(state),
              sessionId,
              getNowIso(config),
              source,
            ),
          );
        }),
      recordInputSource: async (source: ActivityInputSource) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          const current = getCurrentOrIdleRecord(state, nowIso);
          state.inputSummary = recordInputSummarySource(state.inputSummary, source, nowIso);

          await writeSnapshot(state, config, {
            ...current,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'input',
            ...getRuntimeActivitySummaryFields(state, nowIso),
          });
        }),
      recordMessageEnd: async (message: ActivityMessageLike) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          const current = getCurrentOrIdleRecord(state, nowIso);

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
            ...getCurrentOrIdleRecord(state, nowIso),
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
          const current = getCurrentOrIdleRecord(state, nowIso);
          const sanitizedToolCallId = normalizeToolCallId(toolCallId);
          state.activeToolCalls.set(sanitizedToolCallId, { toolName, startedAt: nowIso });
          state.recentToolWindows = upsertToolWindow(
            state.recentToolWindows,
            {
              toolCallId: sanitizedToolCallId,
              toolName,
              startedAt: nowIso,
            },
            nowIso,
          );

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
            ...getRuntimeActivitySummaryFields(state, nowIso),
          });
        }),
      recordToolExecutionUpdate: async ({ toolCallId }) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          const current = getCurrentOrIdleRecord(state, nowIso);
          const sanitizedToolCallId = normalizeToolCallId(toolCallId);
          if (!state.activeToolCalls.has(sanitizedToolCallId)) {
            return;
          }

          const nextRecord: SessionActivityRecord = {
            ...current,
            activityState: 'tool-running',
            idle: false,
            busy: true,
            currentTurnStartedAt: current.currentTurnStartedAt ?? nowIso,
            currentToolName: getMostRecentToolName(state.activeToolCalls),
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'tool_update',
            ...getRuntimeActivitySummaryFields(state, nowIso),
          };

          if (!shouldWriteToolUpdate(state, nowIso)) {
            cacheSnapshot(state, nextRecord);
            return;
          }

          await writeSnapshot(state, config, nextRecord);
          state.lastToolUpdateWrittenAtMs = parseTimestamp(nowIso);
        }),
      recordToolExecutionEnd: async ({ toolCallId, toolName, isError }) =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          const current = getCurrentOrIdleRecord(state, nowIso);
          const sanitizedToolCallId = normalizeToolCallId(toolCallId);
          const activeToolCall = state.activeToolCalls.get(sanitizedToolCallId);
          state.activeToolCalls.delete(sanitizedToolCallId);
          if (state.activeToolCalls.size === 0) {
            state.lastToolUpdateWrittenAtMs = null;
          }
          state.recentToolWindows = upsertToolWindow(
            state.recentToolWindows,
            {
              toolCallId: sanitizedToolCallId,
              toolName: activeToolCall?.toolName ?? toolName,
              startedAt: activeToolCall?.startedAt ?? nowIso,
              endedAt: nowIso,
              ...(isError ? { isError: true } : {}),
            },
            nowIso,
          );

          const nextToolName = getMostRecentToolName(state.activeToolCalls);
          const hasActiveTurn = current.currentTurnStartedAt !== null;

          await writeSnapshot(state, config, {
            ...current,
            activityState:
              nextToolName !== null ? 'tool-running' : hasActiveTurn ? 'thinking' : 'idle',
            idle: !hasActiveTurn,
            busy: hasActiveTurn,
            currentToolName: nextToolName,
            lastToolEndedAt: nowIso,
            lastEventAt: nowIso,
            lastError: isError ? createToolFailureError(toolName) : current.lastError,
            ...(isError ? { lastErrorAt: nowIso } : {}),
            activityUpdatedAt: nowIso,
            activitySource: 'tool_end',
            ...getRuntimeActivitySummaryFields(state, nowIso),
          });
        }),
      recordTurnEnd: async () =>
        runSerialized(state, async () => {
          const nowIso = getNowIso(config);
          state.activeToolCalls.clear();
          state.lastToolUpdateWrittenAtMs = null;

          const current = getCurrentOrIdleRecord(state, nowIso);
          await writeSnapshot(state, config, {
            ...current,
            activityState: state.hasActiveTurnError ? 'error' : 'idle',
            idle: !state.hasActiveTurnError,
            busy: false,
            currentTurnStartedAt: null,
            currentToolName: null,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'turn_end',
          });
        }),
      recordCompactionStart: async (event) => {
        if (isAbortSignalAborted(event.signal)) {
          return;
        }

        await runSerialized(state, async () => {
          if (isAbortSignalAborted(event.signal)) {
            return;
          }

          const nowIso = getNowIso(config);
          const current = getCurrentOrIdleRecord(state, nowIso);
          const token = startCompactionLifecycle(state, event.signal, () => {
            void clearCompactionForToken(state, config, token, 'aborted');
          });

          await writeSnapshot(state, config, {
            ...current,
            activityState: 'compacting',
            idle: false,
            busy: true,
            lastEventAt: nowIso,
            activityUpdatedAt: nowIso,
            activitySource: 'compaction_start',
            compaction: {
              state: 'running',
              startedAt: nowIso,
              updatedAt: nowIso,
              reason: normalizeCompactionReason(event.reason),
              willRetry: event.willRetry === true,
            },
          });

          if (isAbortSignalAborted(event.signal) && state.compactionToken === token) {
            await clearCompactionWithinMutation(state, config, 'aborted');
          }
        });
      },
      clearCompaction: async (reason) =>
        runSerialized(state, async () => {
          await clearCompactionWithinMutation(state, config, reason);
        }),
      getActivity: () => state.cachedActivity,
      isRunning: () => getActivityRuntimeState().activeTimer !== null,
    } satisfies ActivityRuntimeController;
    Object.assign(controller, {
      activityRuntimeApiVersion: ACTIVITY_RUNTIME_CONTROLLER_API_VERSION,
    });

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
            resetCompactionLifecycle(state);
            state.activeToolCalls.clear();
            state.inputSummary = {};
            state.recentToolWindows = [];
            state.lastToolUpdateWrittenAtMs = null;
            state.hasActiveTurnError = false;
            await writeSnapshot(
              state,
              config,
              createIdleActivityRecord(runtimeId, sessionId, nowIso, 'new'),
            );
            return;
          }

          const current = getCurrentOrIdleRecord(state, nowIso);
          await writeSnapshot(state, config, {
            ...current,
            activityUpdatedAt: nowIso,
            activitySource: 'periodic',
            ...getRuntimeActivitySummaryFields(state, nowIso),
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
  stopActivityRuntimeTimer(state);

  state.activeStartPromise = null;
  state.activeDirectory = undefined;
  state.activeClearInterval = globalThis.clearInterval;
  state.runtimeId = undefined;
  state.sessionManager = null;
  state.lastSeenSessionId = null;
  state.activeToolCalls.clear();
  state.inputSummary = {};
  state.recentToolWindows = [];
  state.lastToolUpdateWrittenAtMs = null;
  state.hasActiveTurnError = false;
  state.runtimeDiagnostics = [];
  resetCompactionLifecycle(state);
  state.pendingMutation = Promise.resolve();
}

export async function resetActivityRuntimeForTests(): Promise<void> {
  const state = getActivityRuntimeState();
  await stopActivityRuntime();
  state.cachedActivity = null;
}

function migrateActivityRuntimeState(state: ActivityRuntimeState): void {
  state.pendingMutation ??= Promise.resolve();
  state.lastToolUpdateWrittenAtMs ??= null;
  state.compactionToken ??= 0;
  state.compactionAbortCleanup ??= null;
}

function hasCurrentActivityRuntimeControllerApi(controller: ActivityRuntimeController): boolean {
  const candidate = controller as Partial<ActivityRuntimeController> & {
    activityRuntimeApiVersion?: number;
  };
  return (
    candidate.activityRuntimeApiVersion === ACTIVITY_RUNTIME_CONTROLLER_API_VERSION &&
    typeof candidate.recordToolExecutionUpdate === 'function' &&
    typeof candidate.recordCompactionStart === 'function' &&
    typeof candidate.clearCompaction === 'function'
  );
}

function stopActivityRuntimeTimer(state: ActivityRuntimeState): void {
  if (state.activeTimer !== null) {
    state.activeClearInterval(state.activeTimer);
    state.activeTimer = null;
  }
}

function createIdleActivityRecord(
  runtimeId: string,
  sessionId: string | null,
  nowIso: string,
  source: NonNullable<SessionActivityRecord['activitySource']>,
): SessionActivityRecord {
  return {
    runtimeId,
    sessionId,
    activityState: 'idle',
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

async function clearCompactionForToken(
  state: ActivityRuntimeState,
  config: ActivityRuntimeConfig,
  token: number,
  reason: 'aborted' | 'expired',
): Promise<void> {
  await runSerialized(state, async () => {
    if (state.compactionToken !== token) {
      return;
    }

    await clearCompactionWithinMutation(state, config, reason);
  });
}

async function clearCompactionWithinMutation(
  state: ActivityRuntimeState,
  config: ActivityRuntimeConfig,
  reason: 'completed' | 'aborted' | 'shutdown' | 'session-change' | 'expired',
): Promise<void> {
  const nowIso = getNowIso(config);
  const current = getCurrentOrIdleRecord(state, nowIso);
  resetCompactionLifecycle(state);

  await writeSnapshot(state, config, {
    ...current,
    ...deriveRuntimeActivityFields(state, current, nowIso),
    lastEventAt: nowIso,
    activityUpdatedAt: nowIso,
    activitySource: getCompactionClearSource(reason),
    compaction: null,
  });
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function startCompactionLifecycle(
  state: ActivityRuntimeState,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): number {
  resetCompactionLifecycle(state);
  const token = state.compactionToken + 1;
  state.compactionToken = token;

  if (signal !== undefined) {
    const abortHandler = (): void => onAbort();
    signal.addEventListener('abort', abortHandler, { once: true });
    state.compactionAbortCleanup = () => signal.removeEventListener('abort', abortHandler);
  }

  return token;
}

function resetCompactionLifecycle(state: ActivityRuntimeState): void {
  state.compactionToken += 1;
  state.compactionAbortCleanup?.();
  state.compactionAbortCleanup = null;
}

function getCompactionClearSource(
  reason: 'completed' | 'aborted' | 'shutdown' | 'session-change' | 'expired',
): NonNullable<SessionActivityRecord['activitySource']> {
  switch (reason) {
    case 'completed':
      return 'compaction_end';
    case 'expired':
      return 'compaction_expired';
    case 'aborted':
    case 'shutdown':
    case 'session-change':
      return 'compaction_abort';
  }
}

function normalizeCompactionReason(value: unknown): SessionCompactionReason {
  switch (value) {
    case 'manual':
    case 'threshold':
    case 'overflow':
      return value;
    default:
      return null;
  }
}

function getCurrentOrIdleRecord(
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
  resetCompactionLifecycle(state);
  state.activeToolCalls.clear();
  state.inputSummary = {};
  state.recentToolWindows = [];
  state.lastToolUpdateWrittenAtMs = null;
  state.hasActiveTurnError = false;
  return createIdleActivityRecord(runtimeId, sessionId, nowIso, 'new');
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

function recordInputSummarySource(
  summary: ActivityInputSummary,
  source: ActivityInputSource,
  nowIso: string,
): ActivityInputSummary {
  const counts = { ...(summary.counts ?? {}) };
  counts[source] = (counts[source] ?? 0) + 1;

  return {
    lastSource: source,
    lastInputAt: nowIso,
    counts,
  };
}

function getRuntimeActivitySummaryFields(
  state: ActivityRuntimeState,
  nowIso: string,
): Pick<SessionActivityRecord, 'inputSummary' | 'recentToolWindows'> {
  state.recentToolWindows = trimRecentToolWindows(state.recentToolWindows, nowIso);
  return {
    ...(hasInputSummary(state.inputSummary) ? { inputSummary: state.inputSummary } : {}),
    ...(state.recentToolWindows.length === 0
      ? {}
      : { recentToolWindows: state.recentToolWindows.map(copyToolWindow) }),
  };
}

function hasInputSummary(summary: ActivityInputSummary): boolean {
  return (
    summary.lastSource !== undefined ||
    summary.lastInputAt !== undefined ||
    Object.values(summary.counts ?? {}).some((count) => count > 0)
  );
}

function upsertToolWindow(
  windows: ActivityToolWindow[],
  window: ActivityToolWindow,
  nowIso: string,
): ActivityToolWindow[] {
  const next = windows.filter((candidate) => candidate.toolCallId !== window.toolCallId);
  next.push(copyToolWindow(window));
  return trimRecentToolWindows(next, nowIso);
}

function trimRecentToolWindows(
  windows: ActivityToolWindow[],
  nowIso: string,
): ActivityToolWindow[] {
  const cutoffMs = Date.parse(nowIso) - RECENT_TOOL_WINDOW_MAX_AGE_MS;
  const recent = windows.filter((window) => {
    if (window.endedAt === undefined) {
      return true;
    }

    const referenceMs = Date.parse(window.endedAt);
    return !Number.isFinite(cutoffMs) || !Number.isFinite(referenceMs) || referenceMs >= cutoffMs;
  });

  return recent.slice(Math.max(0, recent.length - MAX_RECENT_TOOL_WINDOWS)).map(copyToolWindow);
}

function copyToolWindow(window: ActivityToolWindow): ActivityToolWindow {
  return {
    toolCallId: window.toolCallId,
    toolName: window.toolName,
    startedAt: window.startedAt,
    ...(window.endedAt === undefined ? {} : { endedAt: window.endedAt }),
    ...(window.isError === true ? { isError: true } : {}),
  };
}

function normalizeToolCallId(toolCallId: string): string {
  return toolCallId.length > 0 ? toolCallId : 'unknown-tool-call';
}

function shouldWriteToolUpdate(state: ActivityRuntimeState, nowIso: string): boolean {
  const nowMs = parseTimestamp(nowIso);
  const lastWriteMs = state.lastToolUpdateWrittenAtMs;
  if (nowMs === null || lastWriteMs === null || nowMs < lastWriteMs) {
    return true;
  }

  return nowMs - lastWriteMs >= DEFAULT_ACTIVITY_REFRESH_INTERVAL_MS;
}

function applyCompactionRetention(
  state: ActivityRuntimeState,
  record: SessionActivityRecord,
): SessionActivityRecord {
  if (isCompactionLifecycleSource(record.activitySource)) {
    return record;
  }

  const compaction = record.compaction;
  if (compaction?.state !== 'running') {
    return record;
  }

  const referenceMs = parseTimestamp(record.activityUpdatedAt ?? record.lastEventAt);
  const updatedMs = parseTimestamp(compaction.updatedAt);
  if (
    referenceMs === null ||
    updatedMs === null ||
    referenceMs - updatedMs > DEFAULT_ACTIVITY_THRESHOLDS.compactionStaleAfterMs
  ) {
    resetCompactionLifecycle(state);
    const nowIso = record.activityUpdatedAt ?? record.lastEventAt ?? compaction.updatedAt;
    return {
      ...record,
      ...deriveRuntimeActivityFields(state, record, nowIso),
      activitySource: 'compaction_expired',
      compaction: null,
    };
  }

  return {
    ...record,
    activityState: 'compacting',
    idle: false,
    busy: true,
    compaction,
  };
}

function deriveRuntimeActivityFields(
  state: ActivityRuntimeState,
  current: SessionActivityRecord,
  nowIso: string,
): Pick<
  SessionActivityRecord,
  'activityState' | 'idle' | 'busy' | 'currentTurnStartedAt' | 'currentToolName'
> {
  const activeToolName = getMostRecentToolName(state.activeToolCalls);
  if (activeToolName !== null) {
    return {
      activityState: 'tool-running',
      idle: false,
      busy: true,
      currentTurnStartedAt: current.currentTurnStartedAt ?? nowIso,
      currentToolName: activeToolName,
    };
  }

  if (current.currentTurnStartedAt !== null && !state.hasActiveTurnError) {
    return {
      activityState: 'thinking',
      idle: false,
      busy: true,
      currentTurnStartedAt: current.currentTurnStartedAt,
      currentToolName: null,
    };
  }

  if (
    state.hasActiveTurnError ||
    (current.activityState === 'error' && current.lastError !== null)
  ) {
    return {
      activityState: 'error',
      idle: false,
      busy: false,
      currentTurnStartedAt: null,
      currentToolName: null,
    };
  }

  return {
    activityState: 'idle',
    idle: true,
    busy: false,
    currentTurnStartedAt: null,
    currentToolName: null,
  };
}

function isCompactionLifecycleSource(source: SessionActivityRecord['activitySource']): boolean {
  return (
    source === 'compaction_start' ||
    source === 'compaction_end' ||
    source === 'compaction_abort' ||
    source === 'compaction_expired'
  );
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function cacheSnapshot(
  state: ActivityRuntimeState,
  record: SessionActivityRecord,
): SessionActivityRecord {
  const recordToWrite = applyCompactionRetention(state, record);
  state.cachedActivity = recordToWrite;
  return recordToWrite;
}

async function writeSnapshot(
  state: ActivityRuntimeState,
  config: ActivityRuntimeConfig,
  record: SessionActivityRecord,
): Promise<void> {
  const recordToWrite = cacheSnapshot(state, record);

  try {
    await (config.writeRecord ?? writeActivityRecord)(recordToWrite, {
      ...(state.activeDirectory === undefined ? {} : { directory: state.activeDirectory }),
    });
    state.runtimeDiagnostics = [];
  } catch (error) {
    const diagnostic: ActivityDiagnostic = {
      code: 'activity_write_error',
      message: `Failed to write activity record: ${getErrorMessage(error)}`,
      runtimeId: recordToWrite.runtimeId,
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
