export const LIFECYCLE_TIMINGS = {
  activityStaleAfterMs: 2 * 60 * 1000,
  toolStuckAfterMs: 10 * 60 * 1000,
  futureSkewMs: 5 * 1000,
  maintenanceIntervalMs: 30 * 1000,
  toolPublishCoalesceMs: 30 * 1000,
  compactionDemoteAfterMs: 2 * 60 * 1000,
  compactionExpireAfterMs: 10 * 60 * 1000,
} as const;

export const MAX_TOOL_NAME_LENGTH = 64;

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export type LifecycleActivityState =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  | 'compacting'
  | 'awaiting-input'
  | 'error'
  | 'unknown';

export type LifecycleTime = number | Date;
export type LifecycleInputSource = 'interactive' | 'rpc' | 'extension';
export type LifecycleUiWaitKind = 'select' | 'input' | 'editor' | 'confirm';
export type LifecycleAssistantError = 'error' | 'aborted';
export type LifecycleCompactionReason = 'manual' | 'threshold' | 'overflow' | null;

export interface LifecycleCompaction {
  generation: number;
  startedAt: number;
  updatedAt: number;
  reason: LifecycleCompactionReason;
  willRetry: boolean;
}

export interface LifecycleTool {
  toolCallId: string;
  toolName: string | null;
  startedAt: number;
  lastEventAt: number;
}

export interface LifecycleUiWait {
  waitId: string;
  kind: LifecycleUiWaitKind;
  startedAt: number;
}

export interface LifecycleCompactionSnapshot {
  startedAt: number;
  updatedAt: number;
  reason: LifecycleCompactionReason;
  willRetry: boolean;
  stale: boolean;
}

export interface LifecycleSnapshot {
  state: LifecycleActivityState;
  toolName: string | null;
  transitionAt: number;
  lastEventAt: number | null;
  compaction: LifecycleCompactionSnapshot | null;
}

export interface LifecycleReducerState {
  runtimeId: string | null;
  sessionId: string | null;
  initialized: boolean;
  closed: boolean;
  eventSeq: number;
  activeTurn: { turnIndex: number; startedAt: number } | null;
  lastTurnIndex: number | null;
  settlementRequired: boolean;
  activeTools: readonly LifecycleTool[];
  uiWaits: readonly LifecycleUiWait[];
  nextWaitId: number;
  assistantError: LifecycleAssistantError | null;
  compactionGeneration: number;
  compaction: LifecycleCompaction | null;
  lastEventAt: number | null;
  lastMessageAt: number | null;
  activityUpdatedAt: number | null;
  transitionAt: number;
  idleTrusted: boolean;
  lastToolUpdatePublishedAt: number | null;
  lastAgentEndAt: number | null;
  lastSnapshot: LifecycleSnapshot | null;
}

export interface CreateLifecycleStateOptions {
  runtimeId?: string | null;
  sessionId?: string | null;
  initialized?: boolean;
  now?: LifecycleTime;
}

interface TimedLifecycleEvent {
  at?: number;
}

export type LifecycleEvent =
  | (TimedLifecycleEvent & {
      type: 'session_start';
      sessionId: string | null;
      runtimeId?: string;
    })
  | (TimedLifecycleEvent & {
      type: 'input';
      source: LifecycleInputSource;
    })
  | (TimedLifecycleEvent & {
      type: 'message_end';
      role: 'user' | 'assistant';
      stopReason?: string;
    })
  | (TimedLifecycleEvent & {
      type: 'turn_start';
      turnIndex: number;
    })
  | (TimedLifecycleEvent & {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName?: string;
    })
  | (TimedLifecycleEvent & {
      type: 'tool_execution_update';
      toolCallId: string;
      meaningful?: boolean;
    })
  | (TimedLifecycleEvent & {
      type: 'tool_execution_end';
      toolCallId: string;
      isError?: boolean;
    })
  | (TimedLifecycleEvent & {
      type: 'turn_end';
      turnIndex: number;
    })
  | (TimedLifecycleEvent & {
      type: 'ui_wait_start' | 'ui_dialog_start';
      waitId?: string;
      kind: LifecycleUiWaitKind;
    })
  | (TimedLifecycleEvent & {
      type: 'ui_wait_end' | 'ui_dialog_end';
      waitId: string;
    })
  | (TimedLifecycleEvent & {
      type: 'ui_wait_clear' | 'ui_dialog_clear';
    })
  | (TimedLifecycleEvent & {
      type: 'session_before_compact';
      reason?: LifecycleCompactionReason;
      willRetry?: boolean;
      aborted?: boolean;
    })
  | (TimedLifecycleEvent & {
      type: 'compaction_abort';
      generation: number;
    })
  | (TimedLifecycleEvent & { type: 'session_compact' })
  | (TimedLifecycleEvent & {
      type: 'maintenance';
      sessionId?: string | null;
    })
  | (TimedLifecycleEvent & { type: 'agent_end' })
  | (TimedLifecycleEvent & {
      type: 'agent_settled';
      isIdle: boolean;
    })
  | (TimedLifecycleEvent & { type: 'session_shutdown' });

export interface LifecycleTransition {
  state: LifecycleReducerState;
  snapshot: LifecycleSnapshot;
  accepted: boolean;
  changed: boolean;
  shouldPublish: boolean;
  generatedWaitId: string | null;
}

interface Mutation {
  state: LifecycleReducerState;
  accepted: boolean;
  forcePublish?: boolean;
  toolUpdateAccepted?: boolean;
  generatedWaitId?: string;
}

export function createLifecycleState(
  options: CreateLifecycleStateOptions = {},
): LifecycleReducerState {
  const nowMs = toTimeMs(options.now ?? 0);
  const runtimeId = normalizeIdentity(options.runtimeId);
  const sessionId = normalizeIdentity(options.sessionId);
  const initialized = options.initialized ?? options.sessionId !== undefined;
  const trustedSession = initialized && sessionId !== null;

  return {
    runtimeId,
    sessionId,
    initialized,
    closed: false,
    eventSeq: 0,
    activeTurn: null,
    lastTurnIndex: null,
    settlementRequired: false,
    activeTools: [],
    uiWaits: [],
    nextWaitId: 0,
    assistantError: null,
    compactionGeneration: 0,
    compaction: null,
    lastEventAt: trustedSession ? nowMs : null,
    lastMessageAt: null,
    activityUpdatedAt: trustedSession ? nowMs : null,
    transitionAt: nowMs,
    idleTrusted: trustedSession,
    lastToolUpdatePublishedAt: null,
    lastAgentEndAt: null,
    lastSnapshot: null,
  };
}

export function reduceLifecycle(
  state: LifecycleReducerState,
  event: LifecycleEvent,
  now: LifecycleTime,
): LifecycleTransition {
  const nowMs = toTimeMs(now);
  const beforeSnapshot = state.lastSnapshot ?? deriveLifecycleSnapshot(state, nowMs);

  if (state.closed) {
    return {
      state,
      snapshot: deriveLifecycleSnapshot(state, nowMs),
      accepted: false,
      changed: false,
      shouldPublish: false,
      generatedWaitId: null,
    };
  }

  const mutation = applyEvent(state, event, nowMs);
  if (!mutation.accepted) {
    return {
      state,
      snapshot: deriveLifecycleSnapshot(state, nowMs),
      accepted: false,
      changed: false,
      shouldPublish: false,
      generatedWaitId: null,
    };
  }

  const expiredState = expireCompaction(mutation.state, nowMs);
  const candidateSnapshot = deriveLifecycleSnapshot(expiredState, nowMs);
  const displayChanged = !sameDisplayedFacts(beforeSnapshot, candidateSnapshot);
  const eventAt = getEventTime(event, nowMs) ?? nowMs;
  const nextState = {
    ...expiredState,
    ...(displayChanged ? { transitionAt: eventAt } : {}),
  };
  const snapshot = deriveLifecycleSnapshot(nextState, nowMs);

  let shouldPublish = mutation.forcePublish === true || displayChanged;
  let lastToolUpdatePublishedAt = nextState.lastToolUpdatePublishedAt;
  if (mutation.toolUpdateAccepted === true) {
    const previousPublishAt = state.lastToolUpdatePublishedAt;
    const eligible =
      previousPublishAt === null ||
      eventAt - previousPublishAt >= LIFECYCLE_TIMINGS.toolPublishCoalesceMs;
    if (eligible || displayChanged) {
      shouldPublish = true;
      lastToolUpdatePublishedAt = eventAt;
    } else {
      shouldPublish = false;
    }
  }

  const publishedState = shouldPublish
    ? {
        ...nextState,
        lastToolUpdatePublishedAt,
        lastSnapshot: copySnapshot(snapshot),
      }
    : {
        ...nextState,
        lastToolUpdatePublishedAt,
      };

  return {
    state: publishedState,
    snapshot,
    accepted: true,
    changed: true,
    shouldPublish,
    generatedWaitId: mutation.generatedWaitId ?? null,
  };
}

export function deriveLifecycleSnapshot(
  state: LifecycleReducerState,
  now: LifecycleTime,
): LifecycleSnapshot {
  const nowMs = toTimeMs(now);
  const compaction = inspectCompaction(state.compaction, nowMs);
  const safeCompaction = compaction.malformedOrFuture ? null : compaction.snapshot;
  const unknown = (): LifecycleSnapshot => createSnapshot(state, 'unknown', null, safeCompaction);

  if (!state.initialized || state.sessionId === null || state.sessionId.length === 0) {
    return unknown();
  }

  if (hasFutureEvidence(state, nowMs, compaction)) {
    return unknown();
  }

  if (compaction.malformedOrFuture) {
    return unknown();
  }

  if (compaction.expired) {
    // Expired persisted compaction is not trusted, but it no longer blocks the
    // underlying state. Maintenance will remove it from the reducer state.
  } else if (compaction.snapshot !== null && !compaction.snapshot.stale) {
    return createSnapshot(state, 'compacting', null, compaction.snapshot);
  }

  if (state.assistantError !== null) {
    return createSnapshot(state, 'error', null, safeCompaction);
  }

  if (state.uiWaits.length > 0) {
    if (!hasValidWaitEvidence(state, nowMs)) {
      return unknown();
    }
    return createSnapshot(state, 'awaiting-input', null, safeCompaction);
  }

  if (state.activeTools.length > 0) {
    if (state.activeTurn === null || !hasFreshActivity(state, nowMs)) {
      return unknown();
    }
    if (hasStuckTool(state, nowMs)) {
      return unknown();
    }
    return createSnapshot(
      state,
      'tool-running',
      getNewestToolName(state.activeTools),
      safeCompaction,
    );
  }

  if (state.activeTurn !== null) {
    if (!hasFreshActivity(state, nowMs)) {
      return unknown();
    }
    return createSnapshot(state, 'thinking', null, safeCompaction);
  }

  if (state.settlementRequired) {
    return unknown();
  }

  if (state.idleTrusted && hasActivityEvidence(state, nowMs)) {
    return createSnapshot(state, 'idle', null, safeCompaction);
  }

  return unknown();
}

export function formatLifecycleLabel(snapshot: LifecycleSnapshot): string {
  switch (snapshot.state) {
    case 'compacting':
      return 'Compacting';
    case 'error':
      return 'Error';
    case 'awaiting-input':
      return 'Needs input';
    case 'tool-running':
      return snapshot.toolName === null ? 'Tool running' : `Tool running: ${snapshot.toolName}`;
    case 'thinking':
      return 'Thinking';
    case 'idle':
      return 'Idle';
    case 'unknown':
      return 'Unknown';
  }
}

export function sanitizeToolName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const withoutAnsi = value.replace(ANSI_ESCAPE_PATTERN, '');
  const withoutControls = replaceControlCharacters(withoutAnsi);
  const compact = withoutControls.replace(/\s+/g, ' ').trim();
  const firstToken = compact.split(' ')[0] ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/.test(firstToken)) {
    return null;
  }

  return firstToken.slice(0, MAX_TOOL_NAME_LENGTH);
}

function applyEvent(state: LifecycleReducerState, event: LifecycleEvent, nowMs: number): Mutation {
  const eventTime = getEventTime(event, nowMs);
  if (eventTime === null) {
    return noMutation(state);
  }

  switch (event.type) {
    case 'session_start':
      return applySessionStart(state, event, eventTime);
    case 'input':
      return applyInput(state, event.source, eventTime);
    case 'message_end':
      return applyMessageEnd(state, event, eventTime);
    case 'turn_start':
      return applyTurnStart(state, event.turnIndex, eventTime);
    case 'tool_execution_start':
      return applyToolStart(state, event, eventTime);
    case 'tool_execution_update':
      return applyToolUpdate(state, event, eventTime);
    case 'tool_execution_end':
      return applyToolEnd(state, event.toolCallId, eventTime);
    case 'turn_end':
      return applyTurnEnd(state, event.turnIndex, eventTime);
    case 'ui_wait_start':
    case 'ui_dialog_start':
      return applyUiWaitStart(state, event, eventTime);
    case 'ui_wait_end':
    case 'ui_dialog_end':
      return applyUiWaitEnd(state, event.waitId, eventTime);
    case 'ui_wait_clear':
    case 'ui_dialog_clear':
      return applyUiWaitClear(state, eventTime);
    case 'session_before_compact':
      return applyCompactionStart(state, event, eventTime);
    case 'compaction_abort':
      return applyCompactionAbort(state, event.generation, eventTime);
    case 'session_compact':
      return applyCompactionComplete(state, eventTime);
    case 'maintenance':
      return applyMaintenance(state, event, eventTime);
    case 'agent_end':
      return acceptedMutation(state, {
        lastAgentEndAt: maxTimestamp(state.lastAgentEndAt, eventTime),
      });
    case 'agent_settled':
      return applyAgentSettled(state, event.isIdle, eventTime);
    case 'session_shutdown':
      return applyShutdown(state, eventTime);
  }
}

function applySessionStart(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'session_start' }>,
  eventTime: number,
): Mutation {
  const sessionId = normalizeIdentity(event.sessionId);
  if (event.sessionId !== null && sessionId === null) {
    return noMutation(state);
  }

  const runtimeId =
    event.runtimeId === undefined ? state.runtimeId : normalizeIdentity(event.runtimeId);
  if (event.runtimeId !== undefined && runtimeId === null) {
    return noMutation(state);
  }

  if (
    state.initialized &&
    state.sessionId === sessionId &&
    (event.runtimeId === undefined || state.runtimeId === runtimeId)
  ) {
    return noMutation(state);
  }

  return {
    state: resetSession(state, sessionId, runtimeId, eventTime),
    accepted: true,
    forcePublish: true,
  };
}

function applyInput(
  state: LifecycleReducerState,
  source: LifecycleInputSource,
  eventTime: number,
): Mutation {
  if (!isInputSource(source)) {
    return noMutation(state);
  }

  return acceptedMutation(state, recordActivity(state, eventTime));
}

function applyMessageEnd(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'message_end' }>,
  eventTime: number,
): Mutation {
  if (event.role !== 'user' && event.role !== 'assistant') {
    return noMutation(state);
  }

  let next = recordActivity(state, eventTime);
  next = {
    ...next,
    lastMessageAt: maxTimestamp(state.lastMessageAt, eventTime),
  };

  if (
    event.role === 'assistant' &&
    (event.stopReason === 'error' || event.stopReason === 'aborted')
  ) {
    next = {
      ...next,
      assistantError: event.stopReason,
      activeTools: [],
      lastToolUpdatePublishedAt: null,
      idleTrusted: false,
    };
  }

  return acceptedMutation(state, next);
}

function applyTurnStart(
  state: LifecycleReducerState,
  turnIndex: number,
  eventTime: number,
): Mutation {
  if (!isTurnIndex(turnIndex)) {
    return noMutation(state);
  }
  if (state.lastTurnIndex !== null && turnIndex <= state.lastTurnIndex) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    activeTurn: { turnIndex, startedAt: eventTime },
    lastTurnIndex: turnIndex,
    settlementRequired: true,
    activeTools: [],
    assistantError: null,
    idleTrusted: false,
    lastToolUpdatePublishedAt: null,
  });
}

function applyToolStart(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'tool_execution_start' }>,
  eventTime: number,
): Mutation {
  if (state.activeTurn === null) {
    return noMutation(state);
  }

  const toolCallId = normalizeOpaqueId(event.toolCallId);
  if (toolCallId === null) {
    return noMutation(state);
  }

  const previous = state.activeTools.find((tool) => tool.toolCallId === toolCallId);
  const toolName =
    event.toolName === undefined ? (previous?.toolName ?? null) : sanitizeToolName(event.toolName);
  if (previous !== undefined && previous.toolName === toolName) {
    return noMutation(state);
  }

  const activeTools = state.activeTools
    .filter((tool) => tool.toolCallId !== toolCallId)
    .concat({ toolCallId, toolName, startedAt: eventTime, lastEventAt: eventTime });
  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    activeTools,
    lastToolUpdatePublishedAt: null,
    idleTrusted: false,
  });
}

function applyToolUpdate(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'tool_execution_update' }>,
  eventTime: number,
): Mutation {
  if (state.activeTurn === null || event.meaningful === false) {
    return noMutation(state);
  }

  const toolCallId = normalizeOpaqueId(event.toolCallId);
  if (toolCallId === null) {
    return noMutation(state);
  }

  const toolIndex = state.activeTools.findIndex((tool) => tool.toolCallId === toolCallId);
  if (toolIndex === -1) {
    return noMutation(state);
  }

  const activeTools = state.activeTools.map((tool, index) =>
    index === toolIndex
      ? { ...tool, lastEventAt: maxTimestamp(tool.lastEventAt, eventTime) ?? tool.lastEventAt }
      : tool,
  );
  const next = recordActivity(state, eventTime);
  return {
    state: acceptedMutation(state, { ...next, activeTools }).state,
    accepted: true,
    toolUpdateAccepted: true,
  };
}

function applyToolEnd(
  state: LifecycleReducerState,
  toolCallIdValue: string,
  eventTime: number,
): Mutation {
  const toolCallId = normalizeOpaqueId(toolCallIdValue);
  if (toolCallId === null || !state.activeTools.some((tool) => tool.toolCallId === toolCallId)) {
    return noMutation(state);
  }

  const activeTools = state.activeTools.filter((tool) => tool.toolCallId !== toolCallId);
  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    activeTools,
    ...(activeTools.length === 0 ? { lastToolUpdatePublishedAt: null } : {}),
  });
}

function applyTurnEnd(
  state: LifecycleReducerState,
  turnIndex: number,
  eventTime: number,
): Mutation {
  if (!isTurnIndex(turnIndex) || state.activeTurn?.turnIndex !== turnIndex) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    activeTurn: null,
    activeTools: [],
    settlementRequired: true,
    idleTrusted: false,
    lastToolUpdatePublishedAt: null,
  });
}

function applyUiWaitStart(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'ui_wait_start' | 'ui_dialog_start' }>,
  eventTime: number,
): Mutation {
  if (!isUiWaitKind(event.kind)) {
    return noMutation(state);
  }

  let waitId: string;
  let nextWaitId = state.nextWaitId;
  if (event.waitId === undefined) {
    do {
      nextWaitId += 1;
      waitId = `${event.kind}-${nextWaitId}`;
    } while (state.uiWaits.some((wait) => wait.waitId === waitId));
  } else {
    const normalizedWaitId = normalizeOpaqueId(event.waitId);
    if (normalizedWaitId === null) {
      return noMutation(state);
    }
    waitId = normalizedWaitId;
  }

  if (state.uiWaits.some((wait) => wait.waitId === waitId)) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return {
    state: acceptedMutation(state, {
      ...next,
      uiWaits: state.uiWaits.concat({ waitId, kind: event.kind, startedAt: eventTime }),
      nextWaitId,
    }).state,
    accepted: true,
    ...(event.waitId === undefined ? { generatedWaitId: waitId } : {}),
  };
}

function applyUiWaitEnd(
  state: LifecycleReducerState,
  waitIdValue: string,
  eventTime: number,
): Mutation {
  const waitId = normalizeOpaqueId(waitIdValue);
  if (waitId === null || !state.uiWaits.some((wait) => wait.waitId === waitId)) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    uiWaits: state.uiWaits.filter((wait) => wait.waitId !== waitId),
  });
}

function applyUiWaitClear(state: LifecycleReducerState, eventTime: number): Mutation {
  if (state.uiWaits.length === 0) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, { ...next, uiWaits: [] });
}

function applyCompactionStart(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'session_before_compact' }>,
  eventTime: number,
): Mutation {
  if (event.aborted === true) {
    return noMutation(state);
  }

  const reason = normalizeCompactionReason(event.reason);
  const willRetry = event.willRetry === true;
  if (
    state.compaction !== null &&
    state.compaction.startedAt === eventTime &&
    state.compaction.reason === reason &&
    state.compaction.willRetry === willRetry
  ) {
    return noMutation(state);
  }

  const nextGeneration = state.compactionGeneration + 1;
  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    compactionGeneration: nextGeneration,
    compaction: {
      generation: nextGeneration,
      startedAt: eventTime,
      updatedAt: eventTime,
      reason,
      willRetry,
    },
  });
}

function applyCompactionAbort(
  state: LifecycleReducerState,
  generation: number,
  eventTime: number,
): Mutation {
  if (
    !Number.isInteger(generation) ||
    generation < 1 ||
    state.compaction === null ||
    state.compaction.generation !== generation
  ) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, { ...next, compaction: null });
}

function applyCompactionComplete(state: LifecycleReducerState, eventTime: number): Mutation {
  if (state.compaction === null) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, { ...next, compaction: null });
}

function applyMaintenance(
  state: LifecycleReducerState,
  event: Extract<LifecycleEvent, { type: 'maintenance' }>,
  eventTime: number,
): Mutation {
  if (event.sessionId !== undefined) {
    const sessionId = normalizeIdentity(event.sessionId);
    if (event.sessionId !== null && sessionId === null) {
      return noMutation(state);
    }
    if (sessionId !== state.sessionId) {
      return {
        state: resetSession(state, sessionId, state.runtimeId, eventTime),
        accepted: true,
        forcePublish: true,
      };
    }
  }

  const next = {
    ...state,
    activityUpdatedAt: maxTimestamp(state.activityUpdatedAt, eventTime),
  };
  return {
    state: acceptedMutation(state, next).state,
    accepted: true,
    forcePublish: true,
  };
}

function applyAgentSettled(
  state: LifecycleReducerState,
  isIdle: boolean,
  eventTime: number,
): Mutation {
  if (isIdle !== true || !state.settlementRequired) {
    return noMutation(state);
  }

  const next = recordActivity(state, eventTime);
  return acceptedMutation(state, {
    ...next,
    settlementRequired: false,
    idleTrusted: state.activeTurn === null,
  });
}

function applyShutdown(state: LifecycleReducerState, eventTime: number): Mutation {
  const next = recordActivity(state, eventTime);
  return {
    state: acceptedMutation(state, {
      ...next,
      closed: true,
      activeTurn: null,
      activeTools: [],
      uiWaits: [],
      assistantError: null,
      compaction: null,
      settlementRequired: false,
      idleTrusted: true,
      lastToolUpdatePublishedAt: null,
    }).state,
    accepted: true,
    forcePublish: true,
  };
}

function resetSession(
  state: LifecycleReducerState,
  sessionId: string | null,
  runtimeId: string | null,
  eventTime: number,
): LifecycleReducerState {
  return acceptedMutation(state, {
    runtimeId,
    sessionId,
    initialized: true,
    closed: false,
    activeTurn: null,
    lastTurnIndex: null,
    settlementRequired: false,
    activeTools: [],
    uiWaits: [],
    assistantError: null,
    compactionGeneration: state.initialized
      ? state.compactionGeneration + 1
      : state.compactionGeneration,
    compaction: null,
    lastEventAt: eventTime,
    lastMessageAt: null,
    activityUpdatedAt: eventTime,
    idleTrusted: sessionId !== null,
    lastToolUpdatePublishedAt: null,
    lastAgentEndAt: null,
  }).state;
}

function expireCompaction(state: LifecycleReducerState, nowMs: number): LifecycleReducerState {
  const compaction = state.compaction;
  if (
    compaction === null ||
    !Number.isFinite(compaction.updatedAt) ||
    nowMs - compaction.updatedAt <= LIFECYCLE_TIMINGS.compactionExpireAfterMs
  ) {
    return state;
  }

  return { ...state, compaction: null };
}

function inspectCompaction(
  compaction: LifecycleCompaction | null,
  nowMs: number,
): {
  snapshot: LifecycleCompactionSnapshot | null;
  stale: boolean;
  expired: boolean;
  malformedOrFuture: boolean;
} {
  if (compaction === null) {
    return { snapshot: null, stale: false, expired: false, malformedOrFuture: false };
  }

  if (
    !Number.isFinite(compaction.startedAt) ||
    !Number.isFinite(compaction.updatedAt) ||
    compaction.startedAt - nowMs > LIFECYCLE_TIMINGS.futureSkewMs ||
    compaction.updatedAt - nowMs > LIFECYCLE_TIMINGS.futureSkewMs
  ) {
    return { snapshot: null, stale: false, expired: false, malformedOrFuture: true };
  }

  const updatedAge = Math.max(0, nowMs - compaction.updatedAt);
  const stale = updatedAge > LIFECYCLE_TIMINGS.compactionDemoteAfterMs;
  const expired = updatedAge > LIFECYCLE_TIMINGS.compactionExpireAfterMs;
  return {
    snapshot: expired
      ? null
      : {
          startedAt: compaction.startedAt,
          updatedAt: compaction.updatedAt,
          reason: compaction.reason,
          willRetry: compaction.willRetry,
          stale,
        },
    stale,
    expired,
    malformedOrFuture: false,
  };
}

function hasFutureEvidence(
  state: LifecycleReducerState,
  nowMs: number,
  compaction: ReturnType<typeof inspectCompaction>,
): boolean {
  const timestamps = [
    state.lastEventAt,
    state.lastMessageAt,
    state.activityUpdatedAt,
    state.activeTurn?.startedAt,
    ...state.activeTools.flatMap((tool) => [tool.startedAt, tool.lastEventAt]),
    ...state.uiWaits.map((wait) => wait.startedAt),
  ];

  return (
    timestamps.some(
      (timestamp) =>
        timestamp !== null &&
        timestamp !== undefined &&
        (!Number.isFinite(timestamp) || timestamp - nowMs > LIFECYCLE_TIMINGS.futureSkewMs),
    ) || compaction.malformedOrFuture
  );
}

function hasValidWaitEvidence(state: LifecycleReducerState, nowMs: number): boolean {
  return state.uiWaits.every(
    (wait) =>
      Number.isFinite(wait.startedAt) && wait.startedAt - nowMs <= LIFECYCLE_TIMINGS.futureSkewMs,
  );
}

function hasActivityEvidence(state: LifecycleReducerState, nowMs: number): boolean {
  if (state.activityUpdatedAt === null || !Number.isFinite(state.activityUpdatedAt)) {
    return false;
  }
  return state.activityUpdatedAt - nowMs <= LIFECYCLE_TIMINGS.futureSkewMs;
}

function hasFreshActivity(state: LifecycleReducerState, nowMs: number): boolean {
  if (!hasActivityEvidence(state, nowMs) || state.activityUpdatedAt === null) {
    return false;
  }
  return nowMs - state.activityUpdatedAt <= LIFECYCLE_TIMINGS.activityStaleAfterMs;
}

function hasStuckTool(state: LifecycleReducerState, nowMs: number): boolean {
  return state.activeTools.some((tool) => {
    const messageAt =
      state.lastMessageAt !== null && state.lastMessageAt >= tool.startedAt
        ? state.lastMessageAt
        : null;
    const lastAcceptedAt = Math.max(tool.lastEventAt, messageAt ?? tool.lastEventAt);
    return nowMs - lastAcceptedAt > LIFECYCLE_TIMINGS.toolStuckAfterMs;
  });
}

function getNewestToolName(tools: readonly LifecycleTool[]): string | null {
  return tools.at(-1)?.toolName ?? null;
}

function createSnapshot(
  state: LifecycleReducerState,
  activityState: LifecycleActivityState,
  toolName: string | null,
  compaction: LifecycleCompactionSnapshot | null,
): LifecycleSnapshot {
  return {
    state: activityState,
    toolName: activityState === 'tool-running' ? toolName : null,
    transitionAt: state.transitionAt,
    lastEventAt: state.lastEventAt,
    compaction,
  };
}

function sameDisplayedFacts(left: LifecycleSnapshot, right: LifecycleSnapshot): boolean {
  return (
    left.state === right.state &&
    left.toolName === right.toolName &&
    sameCompaction(left.compaction, right.compaction)
  );
}

function sameCompaction(
  left: LifecycleCompactionSnapshot | null,
  right: LifecycleCompactionSnapshot | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt &&
    left.reason === right.reason &&
    left.willRetry === right.willRetry &&
    left.stale === right.stale
  );
}

function copySnapshot(snapshot: LifecycleSnapshot): LifecycleSnapshot {
  return {
    ...snapshot,
    ...(snapshot.compaction === null ? {} : { compaction: { ...snapshot.compaction } }),
  };
}

function acceptedMutation(
  state: LifecycleReducerState,
  patch: Partial<LifecycleReducerState>,
): Mutation {
  return {
    state: { ...state, ...patch, eventSeq: state.eventSeq + 1 },
    accepted: true,
  };
}

function noMutation(state: LifecycleReducerState): Mutation {
  return { state, accepted: false };
}

function recordActivity(state: LifecycleReducerState, eventTime: number): LifecycleReducerState {
  return {
    ...state,
    lastEventAt: maxTimestamp(state.lastEventAt, eventTime),
    activityUpdatedAt: maxTimestamp(state.activityUpdatedAt, eventTime),
  };
}

function getEventTime(event: LifecycleEvent, nowMs: number): number | null {
  const at = event.at;
  if (at === undefined) {
    return nowMs;
  }
  return Number.isFinite(at) ? at : null;
}

function toTimeMs(value: LifecycleTime): number {
  const time = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(time)) {
    throw new RangeError('Lifecycle time must be finite');
  }
  return time;
}

function maxTimestamp(left: number | null, right: number): number {
  return left === null ? right : Math.max(left, right);
}

function normalizeIdentity(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    return null;
  }
  if (hasControlCharacters(value)) {
    return null;
  }
  return value.trim();
}

function normalizeOpaqueId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return null;
  }
  if (hasControlCharacters(value)) {
    return null;
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }
  return result;
}

function normalizeCompactionReason(value: unknown): LifecycleCompactionReason {
  switch (value) {
    case 'manual':
    case 'threshold':
    case 'overflow':
      return value;
    default:
      return null;
  }
}

function isInputSource(value: unknown): value is LifecycleInputSource {
  return value === 'interactive' || value === 'rpc' || value === 'extension';
}

function isUiWaitKind(value: unknown): value is LifecycleUiWaitKind {
  return value === 'select' || value === 'input' || value === 'editor' || value === 'confirm';
}

function isTurnIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
