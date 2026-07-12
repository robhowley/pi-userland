import { getErrorMessage, runNormalizedExecCommand } from './internal.js';
import { loadMergeReadyConfigAsync, type MergeReadyConfig } from './config.js';
import { getMergeReadyStatus } from './merge-ready.js';
import {
  claimMergeReadyStatusBarOwnership,
  isMergeReadyStatusBarSuspended,
  refreshMergeReadyStatusBar,
  suspendMergeReadyStatusBar,
  syncMergeReadyStatusBar,
} from './status-bar.js';
import {
  publishMergeReadyWatchStatus,
  type MergeReadyWatchLifecycleState,
  type MergeReadyWatchSessionRef,
} from './watch-status.js';
import type { MergeReadyExec } from './git.js';
import type {
  MergeReadyOpenItem,
  MergeReadyOpenItemDetail,
  MergeReadyOpenItemId,
  MergeReadyPullRequest,
  MergeReadyRepairGuidanceMap,
  MergeReadyStatus,
  MergeReadyTarget,
} from './types.js';

export const MERGE_READY_WATCH_STATUS_KEY = 'merge-ready-watch';
export const MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS = 60;
export const MERGE_READY_WATCH_MIN_INTERVAL_SECONDS = 15;
export const MERGE_READY_WATCH_MAX_INTERVAL_SECONDS = 3_600;
export const MERGE_READY_WATCH_STOP_SHORTCUT = 'ctrl+shift+s';
export const MERGE_READY_WATCH_STOP_SHORTCUT_LABEL = 'Ctrl-Shift-S';

export const MERGE_READY_WATCH_REPAIR_OPEN_ITEM_IDS = [
  'branch_out_of_date',
  'merge_conflicts',
  'ci_failing',
] as const satisfies ReadonlyArray<MergeReadyOpenItemId>;

export const MERGE_READY_WATCH_WAIT_OPEN_ITEM_IDS = [
  'ci_running',
  'review_pending',
] as const satisfies ReadonlyArray<MergeReadyOpenItemId>;

export const MERGE_READY_WATCH_STOP_OPEN_ITEM_IDS = [
  'no_pull_request',
  'status_ambiguous',
  'draft',
  'changes_requested',
  'unresolved_conversations',
  'merge_blocked',
] as const satisfies ReadonlyArray<MergeReadyOpenItemId>;

export type MergeReadyWatchRepairOpenItemId =
  (typeof MERGE_READY_WATCH_REPAIR_OPEN_ITEM_IDS)[number];
export type MergeReadyWatchWaitOpenItemId = (typeof MERGE_READY_WATCH_WAIT_OPEN_ITEM_IDS)[number];
export type MergeReadyWatchStopOpenItemId = (typeof MERGE_READY_WATCH_STOP_OPEN_ITEM_IDS)[number];

export type MergeReadyWatchActionability = 'repair' | 'wait' | 'stop';

export type MergeReadyWatchClassificationReason =
  | 'no_pull_request'
  | 'terminal_pull_request'
  | 'repairable_open_items'
  | 'ready'
  | 'wait_only_open_items'
  | 'unknown_open_items_present'
  | 'non_actionable_open_items';

export type MergeReadyWatchClassification = {
  actionability: MergeReadyWatchActionability;
  reason: MergeReadyWatchClassificationReason;
  repairItems: MergeReadyOpenItem[];
  waitItems: MergeReadyOpenItem[];
  stopItems: MergeReadyOpenItem[];
  unknownItems?: MergeReadyOpenItem[];
};

export type ParseMergeReadyWatchIntervalSecondsResult =
  | {
      ok: true;
      value: number;
    }
  | {
      ok: false;
      message: string;
    };

export type MergeReadyWatchNotificationLevel = 'info' | 'warning' | 'error';

export type MergeReadyWatchSessionManager = {
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
};

export type MergeReadyWatchContext = {
  cwd: string;
  mode?: 'tui' | 'rpc' | 'json' | 'print';
  isIdle?: () => boolean;
  projectTrusted?: boolean;
  waitForIdle?: () => Promise<void>;
  session?: MergeReadyWatchSessionRef;
  sessionManager?: MergeReadyWatchSessionManager;
  ui: {
    notify: (message: string, type?: MergeReadyWatchNotificationLevel) => void;
    setStatus?: (key: string, status?: string) => void;
    theme?: {
      fg: (color: string, text: string) => string;
    };
  };
  // Compaction callback (blocking) - passed from ExtensionContext
  compact?: (options?: { customInstructions?: string }) => Promise<void>;
};

export type MergeReadyWatchAPI = {
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ) => Promise<void> | void;
  appendEntry?: (customType: string, data?: unknown) => void;
  events?: {
    emit: (channel: string, data: unknown) => void;
  };
  on?: (
    event: 'session_shutdown' | 'agent_end',
    handler: (event: unknown, ctx: unknown) => void | Promise<void>,
  ) => void;
};

export type MergeReadyWatchShortcutContext = {
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
  abort: () => void;
};

export type MergeReadyWatchShortcutAPI = {
  registerShortcut?: (
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: MergeReadyWatchShortcutContext) => Promise<void> | void;
    },
  ) => void;
};

export type MergeReadyWatchStopReason =
  | 'no_pull_request'
  | 'status_ambiguous'
  | 'terminal_pull_request'
  | 'draft'
  | 'changes_requested'
  | 'unresolved_conversations'
  | 'merge_blocked'
  | 'non_actionable_open_items'
  | 'dirty_worktree'
  | 'dirty_check_failed'
  | 'repeated_actionable_signature'
  | 'max_iterations'
  | 'error'
  | 'aborted';

export type MergeReadyWatchResult =
  | {
      kind: 'stopped';
      reason: Exclude<MergeReadyWatchStopReason, 'aborted'>;
      status?: MergeReadyStatus;
      signature?: string;
    }
  | {
      kind: 'aborted';
      reason: 'aborted';
    };

export type MergeReadyWatchLoopDependencies = {
  getStatus?: typeof getMergeReadyStatus;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  checkDirtyWorkingTree?: (options: {
    exec: MergeReadyExec;
    cwd: string;
    timeout?: number;
  }) => Promise<
    | {
        ok: true;
        dirty: boolean;
      }
    | {
        ok: false;
        message: string;
      }
  >;
  syncStatusBar?: typeof syncMergeReadyStatusBar;
  waitForAgentEnd?: (signal: AbortSignal) => Promise<void>;
  publishStatus?: (options: {
    lifecycle: MergeReadyWatchLifecycleState;
    status?: MergeReadyStatus | undefined;
    summary?: string | undefined;
    updatedAt?: string | undefined;
  }) => void;
  maxIterations?: number;
};

export type RunMergeReadyWatchLoopOptions = {
  exec: MergeReadyExec;
  api: Pick<MergeReadyWatchAPI, 'sendUserMessage'>;
  ctx: MergeReadyWatchContext;
  intervalSeconds: number;
  timeout?: number;
  signal: AbortSignal;
  url?: string;
  dependencies?: MergeReadyWatchLoopDependencies;
  // Optional config loader for testing/mocking
  loadConfig?: (
    cwd: string,
    projectTrusted?: boolean,
  ) => Promise<MergeReadyConfig> | MergeReadyConfig;
};

export type StartMergeReadyWatchOptions = {
  api: MergeReadyWatchAPI;
  ctx: MergeReadyWatchContext;
  exec: MergeReadyExec;
  intervalSeconds: number;
  signal?: AbortSignal;
  timeout?: number;
  url?: string;
  dependencies?: MergeReadyWatchLoopDependencies;
};

export type StartMergeReadyWatchResult =
  | {
      ok: true;
      message: string;
      level: 'info';
      promise: Promise<MergeReadyWatchResult>;
    }
  | {
      ok: false;
      message: string;
      level: 'warning' | 'error';
    };

export type MergeReadyWatchPhase = 'watching' | 'repair_queued' | 'stopped';

export type ActiveMergeReadyWatcher = {
  id: number;
  abortController: AbortController;
  targetLabel: string;
  startedAtMs: number;
  promise: Promise<MergeReadyWatchResult>;
  phase: MergeReadyWatchPhase;
  pendingRepairTurn: MergeReadyWatchDeferred<void> | null;
  skipAmbientStatusBarRestoreOnTeardown: boolean;
};

export type StopActiveMergeReadyWatchResult =
  | {
      stopped: true;
      targetLabel: string;
      phase: MergeReadyWatchPhase;
    }
  | {
      stopped: false;
    };

type MergeReadyWatchDeferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type MergeReadyResolvedStopOutcome = {
  reason: Exclude<
    MergeReadyWatchStopReason,
    | 'dirty_worktree'
    | 'dirty_check_failed'
    | 'repeated_actionable_signature'
    | 'max_iterations'
    | 'error'
    | 'aborted'
  >;
  message: string;
  level: MergeReadyWatchNotificationLevel;
};

const REPAIR_OPEN_ITEM_ID_SET = new Set<string>(MERGE_READY_WATCH_REPAIR_OPEN_ITEM_IDS);
const WAIT_OPEN_ITEM_ID_SET = new Set<string>(MERGE_READY_WATCH_WAIT_OPEN_ITEM_IDS);
const STOP_OPEN_ITEM_ID_SET = new Set<string>(MERGE_READY_WATCH_STOP_OPEN_ITEM_IDS);

type MergeReadyWatchRuntimeOwner = MergeReadyWatchAPI | MergeReadyWatchShortcutAPI;

export type MergeReadyWatchRuntimeContext = Pick<
  MergeReadyWatchContext,
  'session' | 'sessionManager'
>;

type MergeReadyWatchRuntimeLocator = {
  owner?: MergeReadyWatchRuntimeOwner | undefined;
  runtimeContext?: MergeReadyWatchRuntimeContext | undefined;
};

type MergeReadyWatchRuntimeState = {
  activeWatcher: ActiveMergeReadyWatcher | null;
  sessionKey?: string;
};

const defaultMergeReadyWatchRuntimeState = createMergeReadyWatchRuntimeState();
const mergeReadyWatchRuntimeStateByOwner = new WeakMap<object, MergeReadyWatchRuntimeState>();
const mergeReadyWatchRuntimeStateBySessionKey = new Map<string, MergeReadyWatchRuntimeState>();
const activeMergeReadyWatchRuntimeStates = new Set<MergeReadyWatchRuntimeState>();
let nextWatcherId = 1;
const pendingWatcherPromises = new Set<Promise<MergeReadyWatchResult>>();

type StopActiveMergeReadyWatchOptions = {
  skipAmbientStatusBarRestore?: boolean;
};

export function registerMergeReadyWatchLifecycle(api: MergeReadyWatchAPI): void {
  api.on?.('session_shutdown', (_event, eventCtx) => {
    const runtimeContext = toMergeReadyWatchRuntimeContext(eventCtx);
    const runtimeState = resolveActiveMergeReadyWatchRuntimeState({ owner: api, runtimeContext });
    if (!runtimeState) {
      return;
    }

    stopActiveMergeReadyWatchForState(runtimeState, {
      skipAmbientStatusBarRestore: true,
    });
  });
  api.on?.('agent_end', (_event, eventCtx) => {
    resolveActiveMergeReadyWatchAgentEnd(api, toMergeReadyWatchRuntimeContext(eventCtx));
  });
}

export function registerMergeReadyWatchShortcut(api: MergeReadyWatchShortcutAPI): void {
  api.registerShortcut?.(MERGE_READY_WATCH_STOP_SHORTCUT, {
    description: 'Stop active merge-ready watch',
    handler: (ctx) => {
      const stop = stopActiveMergeReadyWatch(api);
      if (!stop.stopped) {
        return;
      }

      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.abort();
      }
    },
  });
}

export function getActiveMergeReadyWatch(
  owner?: MergeReadyWatchRuntimeOwner,
  runtimeContext?: MergeReadyWatchRuntimeContext,
): ActiveMergeReadyWatcher | null {
  return resolveActiveMergeReadyWatchRuntimeState({ owner, runtimeContext })?.activeWatcher ?? null;
}

export async function resetMergeReadyWatchState(): Promise<void> {
  for (const runtimeState of [...activeMergeReadyWatchRuntimeStates]) {
    stopActiveMergeReadyWatchForState(runtimeState);
  }
  nextWatcherId = 1;
  await Promise.allSettled([...pendingWatcherPromises]);
  mergeReadyWatchRuntimeStateBySessionKey.clear();
}

function createMergeReadyWatchRuntimeState(sessionKey?: string): MergeReadyWatchRuntimeState {
  return {
    activeWatcher: null,
    ...(sessionKey === undefined ? {} : { sessionKey }),
  };
}

function toMergeReadyWatchRuntimeContext(
  value: unknown,
): MergeReadyWatchRuntimeContext | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  return value as MergeReadyWatchRuntimeContext;
}

function getMergeReadyWatchRuntimeSessionKey(
  runtimeContext: MergeReadyWatchRuntimeContext | undefined,
): string | null {
  const sessionId =
    runtimeContext?.session?.sessionId ?? runtimeContext?.sessionManager?.getSessionId?.();
  if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
    return `id:${sessionId.trim()}`;
  }

  const sessionFile =
    runtimeContext?.session?.sessionFile ?? runtimeContext?.sessionManager?.getSessionFile?.();
  if (typeof sessionFile === 'string' && sessionFile.trim().length > 0) {
    return `file:${sessionFile.trim()}`;
  }

  return null;
}

function lookupMergeReadyWatchRuntimeState(
  options: MergeReadyWatchRuntimeLocator = {},
): MergeReadyWatchRuntimeState | null {
  const sessionKey = getMergeReadyWatchRuntimeSessionKey(options.runtimeContext);
  if (sessionKey) {
    return mergeReadyWatchRuntimeStateBySessionKey.get(sessionKey) ?? null;
  }

  const owner = options.owner;
  if (!owner || typeof owner !== 'object') {
    return null;
  }

  return mergeReadyWatchRuntimeStateByOwner.get(owner) ?? null;
}

function associateMergeReadyWatchRuntimeState(
  runtimeState: MergeReadyWatchRuntimeState,
  options: MergeReadyWatchRuntimeLocator = {},
): MergeReadyWatchRuntimeState {
  const sessionKey = getMergeReadyWatchRuntimeSessionKey(options.runtimeContext);
  if (sessionKey) {
    runtimeState.sessionKey ??= sessionKey;
    mergeReadyWatchRuntimeStateBySessionKey.set(sessionKey, runtimeState);
  }

  const owner = options.owner;
  if (owner && typeof owner === 'object') {
    mergeReadyWatchRuntimeStateByOwner.set(owner, runtimeState);
  }

  return runtimeState;
}

function hasScopedMergeReadyWatchRuntimeLocator(
  options: MergeReadyWatchRuntimeLocator = {},
): boolean {
  return (
    getMergeReadyWatchRuntimeSessionKey(options.runtimeContext) !== null ||
    (options.owner !== undefined && typeof options.owner === 'object')
  );
}

function resolveMergeReadyWatchRuntimeState(
  options: MergeReadyWatchRuntimeLocator = {},
): MergeReadyWatchRuntimeState {
  const existingRuntimeState = lookupMergeReadyWatchRuntimeState(options);
  if (existingRuntimeState) {
    return associateMergeReadyWatchRuntimeState(existingRuntimeState, options);
  }

  const sessionKey = getMergeReadyWatchRuntimeSessionKey(options.runtimeContext);
  if (sessionKey) {
    return associateMergeReadyWatchRuntimeState(
      createMergeReadyWatchRuntimeState(sessionKey),
      options,
    );
  }

  const owner = options.owner;
  if (!owner || typeof owner !== 'object') {
    return defaultMergeReadyWatchRuntimeState;
  }

  return associateMergeReadyWatchRuntimeState(createMergeReadyWatchRuntimeState(), options);
}

function resolveActiveMergeReadyWatchRuntimeState(
  options: MergeReadyWatchRuntimeLocator = {},
): MergeReadyWatchRuntimeState | null {
  const runtimeState = lookupMergeReadyWatchRuntimeState(options);
  if (runtimeState?.activeWatcher) {
    return runtimeState;
  }

  return hasScopedMergeReadyWatchRuntimeLocator(options)
    ? null
    : findSingleActiveMergeReadyWatchRuntimeState();
}

function resolvePendingRepairMergeReadyWatchRuntimeState(
  options: MergeReadyWatchRuntimeLocator = {},
): MergeReadyWatchRuntimeState | null {
  const runtimeState = lookupMergeReadyWatchRuntimeState(options);
  if (runtimeState?.activeWatcher?.pendingRepairTurn) {
    return runtimeState;
  }

  return hasScopedMergeReadyWatchRuntimeLocator(options)
    ? null
    : findSingleActiveMergeReadyWatchRuntimeState((watcher) => watcher.pendingRepairTurn !== null);
}

function findSingleActiveMergeReadyWatchRuntimeState(
  predicate: (watcher: ActiveMergeReadyWatcher) => boolean = () => true,
): MergeReadyWatchRuntimeState | null {
  let match: MergeReadyWatchRuntimeState | null = null;

  for (const runtimeState of activeMergeReadyWatchRuntimeStates) {
    const watcher = runtimeState.activeWatcher;
    if (!watcher || !predicate(watcher)) {
      continue;
    }

    if (match) {
      return null;
    }

    match = runtimeState;
  }

  return match;
}

function releaseMergeReadyWatchRuntimeState(runtimeState: MergeReadyWatchRuntimeState): void {
  if (runtimeState.activeWatcher || runtimeState.sessionKey === undefined) {
    return;
  }

  mergeReadyWatchRuntimeStateBySessionKey.delete(runtimeState.sessionKey);
}

function findMergeReadyWatchRuntimeStateBySignal(
  signal: AbortSignal,
): MergeReadyWatchRuntimeState | null {
  for (const runtimeState of activeMergeReadyWatchRuntimeStates) {
    if (runtimeState.activeWatcher?.abortController.signal === signal) {
      return runtimeState;
    }
  }

  return null;
}

export function parseMergeReadyWatchIntervalSeconds(
  value: number | string | undefined,
): ParseMergeReadyWatchIntervalSecondsResult {
  if (value === undefined) {
    return { ok: true, value: MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS };
  }

  const normalized = typeof value === 'string' ? value.trim() : value;

  if (typeof normalized === 'string') {
    if (!/^\d+$/u.test(normalized)) {
      return {
        ok: false,
        message: 'Watch interval must be a whole number of seconds.',
      };
    }

    return parseMergeReadyWatchIntervalSeconds(Number(normalized));
  }

  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) {
    return {
      ok: false,
      message: 'Watch interval must be a whole number of seconds.',
    };
  }

  if (normalized < MERGE_READY_WATCH_MIN_INTERVAL_SECONDS) {
    return {
      ok: false,
      message: `Watch interval must be at least ${String(MERGE_READY_WATCH_MIN_INTERVAL_SECONDS)} seconds.`,
    };
  }

  if (normalized > MERGE_READY_WATCH_MAX_INTERVAL_SECONDS) {
    return {
      ok: false,
      message: `Watch interval must be at most ${String(MERGE_READY_WATCH_MAX_INTERVAL_SECONDS)} seconds.`,
    };
  }

  return { ok: true, value: normalized };
}

export function classifyMergeReadyWatchStatus(
  status: Pick<MergeReadyStatus, 'openItems' | 'pr' | 'state'>,
): MergeReadyWatchClassification {
  const stopItemsFromStatus = status.openItems.filter((openItem) =>
    STOP_OPEN_ITEM_ID_SET.has(openItem.id),
  );

  if (
    stopItemsFromStatus.some((openItem) => openItem.id === 'no_pull_request') ||
    (status.pr === null && status.openItems.length === 0)
  ) {
    return {
      actionability: 'stop',
      reason: 'no_pull_request',
      repairItems: [],
      waitItems: [],
      stopItems: stopItemsFromStatus,
    };
  }

  if (status.pr !== null && status.pr.lifecycle !== 'open') {
    return {
      actionability: 'stop',
      reason: 'terminal_pull_request',
      repairItems: [],
      waitItems: [],
      stopItems: stopItemsFromStatus,
    };
  }

  const repairItems: MergeReadyOpenItem[] = [];
  const waitItems: MergeReadyOpenItem[] = [];
  const stopItems = [...stopItemsFromStatus];
  const unknownItems: MergeReadyOpenItem[] = [];

  for (const openItem of status.openItems) {
    if (REPAIR_OPEN_ITEM_ID_SET.has(openItem.id)) {
      repairItems.push(openItem);
      continue;
    }

    if (WAIT_OPEN_ITEM_ID_SET.has(openItem.id)) {
      waitItems.push(openItem);
      continue;
    }

    // Items in STOP_OPEN_ITEM_ID_SET are already in stopItemsFromStatus; skip unknown handling
    if (STOP_OPEN_ITEM_ID_SET.has(openItem.id)) {
      continue;
    }

    unknownItems.push(openItem);
  }

  if (stopItems.length > 0) {
    return {
      actionability: 'stop',
      reason: 'non_actionable_open_items',
      repairItems,
      waitItems,
      stopItems,
    };
  }

  if (unknownItems.length > 0) {
    return {
      actionability: 'wait',
      reason: 'unknown_open_items_present',
      repairItems,
      waitItems,
      stopItems,
      unknownItems,
    };
  }

  if (repairItems.length > 0) {
    return {
      actionability: 'repair',
      reason: 'repairable_open_items',
      repairItems,
      waitItems,
      stopItems,
    };
  }

  if (status.openItems.length === 0 && status.state === 'ready') {
    return {
      actionability: 'wait',
      reason: 'ready',
      repairItems,
      waitItems,
      stopItems,
    };
  }

  if (status.openItems.length > 0 && waitItems.length === status.openItems.length) {
    return {
      actionability: 'wait',
      reason: 'wait_only_open_items',
      repairItems,
      waitItems,
      stopItems,
    };
  }

  return {
    actionability: 'stop',
    reason: 'non_actionable_open_items',
    repairItems,
    waitItems,
    stopItems,
  };
}

export function startMergeReadyWatch(
  options: StartMergeReadyWatchOptions,
): StartMergeReadyWatchResult {
  const supportsStopShortcut = usesMergeReadyWatchStopShortcut(options.ctx);
  const runtimeState = resolveMergeReadyWatchRuntimeState({
    owner: options.api,
    runtimeContext: options.ctx,
  });

  if (runtimeState.activeWatcher) {
    return {
      ok: false,
      level: 'warning',
      message: supportsStopShortcut
        ? `Merge-ready watch is already active for ${runtimeState.activeWatcher.targetLabel}. Press ${MERGE_READY_WATCH_STOP_SHORTCUT_LABEL} to stop it before starting another.`
        : `Merge-ready watch is already active for ${runtimeState.activeWatcher.targetLabel}.`,
    };
  }

  if (typeof options.api.sendUserMessage !== 'function') {
    return {
      ok: false,
      level: 'error',
      message: 'Merge-ready watch requires Pi sendUserMessage support.',
    };
  }

  const sendUserMessage = options.api.sendUserMessage;
  const watcher: ActiveMergeReadyWatcher = {
    id: nextWatcherId,
    abortController: new AbortController(),
    targetLabel: formatRequestedTargetLabel(options.url),
    startedAtMs: Date.now(),
    promise: Promise.resolve({ kind: 'aborted', reason: 'aborted' }),
    phase: 'watching',
    pendingRepairTurn: null,
    skipAmbientStatusBarRestoreOnTeardown: false,
  };
  nextWatcherId += 1;
  runtimeState.activeWatcher = watcher;
  activeMergeReadyWatchRuntimeStates.add(runtimeState);

  let lastPublishedLifecycle: MergeReadyWatchLifecycleState | null = null;
  let lastPublishedStatus: MergeReadyStatus | undefined;
  const publishWatchStatus = createMergeReadyWatchStatusPublisher({
    api: options.api,
    ctx: options.ctx,
    ...(options.url === undefined ? {} : { requestedUrl: options.url }),
  });
  const publishStatus = (payload: {
    lifecycle: MergeReadyWatchLifecycleState;
    status?: MergeReadyStatus | undefined;
    summary?: string | undefined;
    updatedAt?: string | undefined;
  }) => {
    options.dependencies?.publishStatus?.(payload);
    if (payload.status) {
      lastPublishedStatus = payload.status;
    }
    lastPublishedLifecycle = payload.lifecycle;
    publishWatchStatus({
      lifecycle: payload.lifecycle,
      status: payload.status,
      summary: payload.summary,
      updatedAt: payload.updatedAt,
    });
  };

  const unlinkParentSignal = linkAbortSignal(options.signal, watcher.abortController);
  const resumeMergeReadyStatusBar = suspendMergeReadyStatusBar(options.ctx);

  setMergeReadyWatchStatus(options.ctx, `Watching ${watcher.targetLabel} · starting…`);
  publishStatus({
    lifecycle: 'starting',
    summary: `Starting merge-ready watch for ${watcher.targetLabel}`,
  });

  const promise = runMergeReadyWatchLoop({
    exec: options.exec,
    api:
      typeof sendUserMessage === 'function'
        ? {
            sendUserMessage: (content, messageOptions) =>
              sendUserMessage.call(options.api, content, messageOptions),
          }
        : {},
    ctx: options.ctx,
    intervalSeconds: options.intervalSeconds,
    signal: watcher.abortController.signal,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.url === undefined ? {} : { url: options.url }),
    dependencies: {
      ...(options.dependencies ?? {}),
      publishStatus,
    },
  })
    .catch((error) => {
      if (isAbortError(error)) {
        return { kind: 'aborted', reason: 'aborted' } satisfies MergeReadyWatchResult;
      }

      const failureMessage = `Merge-ready watch failed: ${getErrorMessage(error)}`;
      publishStatus({
        lifecycle: 'error',
        status: lastPublishedStatus,
        summary: failureMessage,
      });
      options.ctx.ui.notify(`${failureMessage} for ${watcher.targetLabel}.`, 'error');
      return { kind: 'stopped', reason: 'error' } satisfies MergeReadyWatchResult;
    })
    .finally(async () => {
      if (lastPublishedLifecycle !== 'stopped' && lastPublishedLifecycle !== 'error') {
        publishStatus({
          lifecycle: 'stopped',
          status: lastPublishedStatus,
          summary: `Merge-ready watch stopped for ${watcher.targetLabel}`,
        });
      }

      unlinkParentSignal();
      watcher.phase = 'stopped';
      watcher.pendingRepairTurn = null;
      pendingWatcherPromises.delete(watcher.promise);

      const shouldClearWatchStatus =
        runtimeState.activeWatcher === null || runtimeState.activeWatcher.id === watcher.id;
      if (runtimeState.activeWatcher?.id === watcher.id) {
        runtimeState.activeWatcher = null;
        activeMergeReadyWatchRuntimeStates.delete(runtimeState);
      }
      releaseMergeReadyWatchRuntimeState(runtimeState);
      if (shouldClearWatchStatus) {
        setMergeReadyWatchStatus(options.ctx);
      }

      resumeMergeReadyStatusBar();
      if (!watcher.skipAmbientStatusBarRestoreOnTeardown) {
        await restoreAmbientMergeReadyStatusBar({
          exec: options.exec,
          ctx: options.ctx,
        });
      }
    });

  watcher.promise = promise;
  pendingWatcherPromises.add(promise);

  return {
    ok: true,
    level: 'info',
    message: supportsStopShortcut
      ? `Watching merge readiness for ${watcher.targetLabel} every ${String(options.intervalSeconds)}s. Press ${MERGE_READY_WATCH_STOP_SHORTCUT_LABEL} to stop.`
      : `Watching merge readiness for ${watcher.targetLabel} every ${String(options.intervalSeconds)}s.`,
    promise,
  };
}

export function stopActiveMergeReadyWatch(
  owner?: MergeReadyWatchRuntimeOwner,
  runtimeContext?: MergeReadyWatchRuntimeContext,
): StopActiveMergeReadyWatchResult {
  const runtimeState = resolveActiveMergeReadyWatchRuntimeState({ owner, runtimeContext });
  return runtimeState ? stopActiveMergeReadyWatchForState(runtimeState) : { stopped: false };
}

function stopActiveMergeReadyWatchForState(
  runtimeState: MergeReadyWatchRuntimeState,
  options: StopActiveMergeReadyWatchOptions = {},
): StopActiveMergeReadyWatchResult {
  const watcher = runtimeState.activeWatcher;
  if (!watcher) {
    return { stopped: false };
  }

  watcher.skipAmbientStatusBarRestoreOnTeardown ||= options.skipAmbientStatusBarRestore === true;
  runtimeState.activeWatcher = null;
  activeMergeReadyWatchRuntimeStates.delete(runtimeState);
  releaseMergeReadyWatchRuntimeState(runtimeState);
  const phase = watcher.phase;
  if (watcher.pendingRepairTurn) {
    const pendingRepairTurn = watcher.pendingRepairTurn;
    watcher.pendingRepairTurn = null;
    pendingRepairTurn.reject(createAbortError('Aborted'));
  }
  watcher.abortController.abort();

  return {
    stopped: true,
    targetLabel: watcher.targetLabel,
    phase,
  };
}

function waitForActiveMergeReadyWatchAgentEnd(signal: AbortSignal): Promise<void> {
  throwIfMergeReadyWatchAborted(signal);

  const runtimeState = findMergeReadyWatchRuntimeStateBySignal(signal);
  const watcher = runtimeState?.activeWatcher;
  if (!watcher) {
    return Promise.reject(
      new Error('Merge-ready watch agent_end waiting requires an active watcher.'),
    );
  }

  const pendingRepairTurn = createMergeReadyWatchDeferred<void>();
  watcher.phase = 'repair_queued';
  watcher.pendingRepairTurn = pendingRepairTurn;

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal.reason));
    };

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (watcher.pendingRepairTurn === pendingRepairTurn) {
        watcher.phase = 'watching';
        watcher.pendingRepairTurn = null;
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    pendingRepairTurn.promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function resolveActiveMergeReadyWatchAgentEnd(
  owner?: MergeReadyWatchRuntimeOwner,
  runtimeContext?: MergeReadyWatchRuntimeContext,
): void {
  const runtimeState = resolvePendingRepairMergeReadyWatchRuntimeState({ owner, runtimeContext });
  const watcher = runtimeState?.activeWatcher;
  const pendingRepairTurn = watcher?.pendingRepairTurn;
  if (!watcher || !pendingRepairTurn) {
    return;
  }

  watcher.phase = 'watching';
  watcher.pendingRepairTurn = null;
  pendingRepairTurn.resolve();
}

function rejectActiveMergeReadyWatchAgentEnd(error: unknown, signal: AbortSignal): void {
  const runtimeState = findMergeReadyWatchRuntimeStateBySignal(signal);
  const watcher = runtimeState?.activeWatcher;
  const pendingRepairTurn = watcher?.pendingRepairTurn;
  if (!watcher || !pendingRepairTurn) {
    return;
  }

  watcher.phase = 'watching';
  watcher.pendingRepairTurn = null;
  pendingRepairTurn.reject(error);
}

function createMergeReadyWatchDeferred<T>(): MergeReadyWatchDeferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) {
    return () => {};
  }

  const abortTarget = () => {
    target.abort(source.reason);
  };

  if (source.aborted) {
    abortTarget();
    return () => {};
  }

  source.addEventListener('abort', abortTarget, { once: true });
  return () => {
    source.removeEventListener('abort', abortTarget);
  };
}

export async function runMergeReadyWatchLoop(
  options: RunMergeReadyWatchLoopOptions,
): Promise<MergeReadyWatchResult> {
  const getStatus = options.dependencies?.getStatus ?? getMergeReadyStatus;
  const sleep = options.dependencies?.sleep ?? sleepWithAbort;
  const checkDirtyWorkingTree =
    options.dependencies?.checkDirtyWorkingTree ?? getMergeReadyWatchDirtyWorktreeState;
  const syncStatusBar = options.dependencies?.syncStatusBar ?? syncMergeReadyStatusBar;
  const waitForAgentEnd =
    options.dependencies?.waitForAgentEnd ?? waitForActiveMergeReadyWatchAgentEnd;
  const publishStatus = options.dependencies?.publishStatus;
  const maxIterations = options.dependencies?.maxIterations;
  const attemptedSignatures = new Set<string>();
  let iterations = 0;
  let lastStatus: MergeReadyStatus | undefined;

  try {
    while (true) {
      throwIfMergeReadyWatchAborted(options.signal);

      if (maxIterations !== undefined && iterations >= maxIterations) {
        publishStatus?.({
          lifecycle: 'stopped',
          status: lastStatus,
          summary: 'Merge-ready watch iteration limit reached',
        });
        return {
          kind: 'stopped',
          reason: 'max_iterations',
          ...(lastStatus ? { status: lastStatus } : {}),
        };
      }
      iterations += 1;

      const ownership =
        options.url === undefined
          ? claimMergeReadyStatusBarOwnership({
              exec: options.exec,
              ctx: {
                cwd: options.ctx.cwd,
                ui: options.ctx.ui,
              },
            })
          : undefined;
      const status = await getStatus({
        exec: options.exec,
        cwd: options.ctx.cwd,
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      });
      lastStatus = status;
      throwIfMergeReadyWatchAborted(options.signal);

      syncStatusBar({
        ctx: {
          cwd: options.ctx.cwd,
          ui: options.ctx.ui,
        },
        status,
        ...(options.ctx.projectTrusted === undefined
          ? {}
          : { projectTrusted: options.ctx.projectTrusted }),
        ...(ownership === undefined ? {} : { ownership }),
      });
      publishStatus?.({ lifecycle: 'watching', status });

      const classification = classifyMergeReadyWatchStatus(status);
      if (classification.actionability === 'stop') {
        const stopOutcome = resolveMergeReadyWatchStopOutcome(status, classification);
        setMergeReadyWatchStatus(options.ctx, `Stopped · ${stopOutcome.message}`);
        publishStatus?.({ lifecycle: 'stopped', status, summary: stopOutcome.message });
        options.ctx.ui.notify(
          `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: ${stopOutcome.message}`,
          stopOutcome.level,
        );
        return { kind: 'stopped', reason: stopOutcome.reason, status };
      }

      if (classification.actionability === 'wait') {
        if (classification.reason === 'unknown_open_items_present' && classification.unknownItems) {
          options.ctx.ui.notify(
            `Merge-ready watch: unrecognized items present (${classification.unknownItems.map((i) => i.id).join(', ')})`,
            'warning',
          );
        }
        setMergeReadyWatchStatus(
          options.ctx,
          `Watching ${formatStatusSubject(status)} · ${status.summary}`,
        );
        await sleep(options.intervalSeconds * 1_000, options.signal);
        throwIfMergeReadyWatchAborted(options.signal);
        continue;
      }

      const signature = createMergeReadyWatchBlockerSignature(status, classification.repairItems);
      if (attemptedSignatures.has(signature)) {
        setMergeReadyWatchStatus(options.ctx, 'Stopped · repeated actionable blocker');
        publishStatus?.({
          lifecycle: 'stopped',
          status,
          summary: 'The same actionable blocker is still present after one attempt.',
        });
        options.ctx.ui.notify(
          `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: the same actionable blocker is still present after one attempt.`,
          'warning',
        );
        return {
          kind: 'stopped',
          reason: 'repeated_actionable_signature',
          status,
          signature,
        };
      }

      if (status.target.mode === 'current_branch') {
        const dirtyState = await checkDirtyWorkingTree({
          exec: options.exec,
          cwd: options.ctx.cwd,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        });
        throwIfMergeReadyWatchAborted(options.signal);
        if (!dirtyState.ok) {
          setMergeReadyWatchStatus(options.ctx, 'Stopped · git working tree preflight failed');
          publishStatus?.({ lifecycle: 'stopped', status, summary: dirtyState.message });
          options.ctx.ui.notify(
            `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: ${dirtyState.message}`,
            'warning',
          );
          return { kind: 'stopped', reason: 'dirty_check_failed', status };
        }

        if (dirtyState.dirty) {
          setMergeReadyWatchStatus(options.ctx, 'Stopped · dirty working tree');
          publishStatus?.({
            lifecycle: 'stopped',
            status,
            summary: 'Local git changes are present, so auto-repair is disabled.',
          });
          options.ctx.ui.notify(
            `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: local git changes are present, so auto-repair is disabled.`,
            'warning',
          );
          return { kind: 'stopped', reason: 'dirty_worktree', status };
        }
      }

      attemptedSignatures.add(signature);
      const repairSummary = `${classification.repairItems.map((openItem) => openItem.id).join(', ')} repair queued`;
      setMergeReadyWatchStatus(
        options.ctx,
        `Repair queued ${formatStatusSubject(status)} · ${classification.repairItems.map((openItem) => openItem.id).join(', ')}`,
      );
      publishStatus?.({ lifecycle: 'repairing', status, summary: repairSummary });
      options.ctx.ui.notify(
        `Queued repair for ${formatStatusTargetLabel(status)} for ${classification.repairItems.map((openItem) => openItem.id).join(', ')}.`,
        'info',
      );

      if (typeof options.api.sendUserMessage !== 'function') {
        setMergeReadyWatchStatus(options.ctx, 'Stopped · repair handoff unavailable');
        publishStatus?.({
          lifecycle: 'error',
          status,
          summary: 'Pi sendUserMessage support is required for auto-repair.',
        });
        options.ctx.ui.notify(
          `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: Pi sendUserMessage support is required for auto-repair.`,
          'error',
        );
        return { kind: 'stopped', reason: 'error', status };
      }

      const loadConfigFn = options.loadConfig ?? loadMergeReadyConfigAsync;
      const config = await loadConfigFn(options.ctx.cwd, options.ctx.projectTrusted ?? false);
      throwIfMergeReadyWatchAborted(options.signal);

      const agentEnd = waitForAgentEnd(options.signal);
      let sendUserMessageResult: Promise<void> | void;
      try {
        sendUserMessageResult = options.api.sendUserMessage(
          createMergeReadyWatchRepairPrompt(
            status,
            classification.repairItems,
            config.repairGuidance,
          ),
          resolveSendUserMessageOptions(),
        );
      } catch (error) {
        rejectActiveMergeReadyWatchAgentEnd(error, options.signal);
        throw error;
      }

      const repairDispatchFailure = Promise.resolve(sendUserMessageResult).then(
        () => new Promise<never>(() => {}),
        (error) => {
          rejectActiveMergeReadyWatchAgentEnd(error, options.signal);
          throw error;
        },
      );

      await Promise.race([agentEnd, repairDispatchFailure]);
      throwIfMergeReadyWatchAborted(options.signal);

      const refreshedOwnership =
        options.url === undefined
          ? claimMergeReadyStatusBarOwnership({
              exec: options.exec,
              ctx: {
                cwd: options.ctx.cwd,
                ui: options.ctx.ui,
              },
            })
          : undefined;
      const refreshedStatus = await getStatus({
        exec: options.exec,
        cwd: options.ctx.cwd,
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      });
      lastStatus = refreshedStatus;
      throwIfMergeReadyWatchAborted(options.signal);

      syncStatusBar({
        ctx: {
          cwd: options.ctx.cwd,
          ui: options.ctx.ui,
        },
        status: refreshedStatus,
        ...(options.ctx.projectTrusted === undefined
          ? {}
          : { projectTrusted: options.ctx.projectTrusted }),
        ...(refreshedOwnership === undefined ? {} : { ownership: refreshedOwnership }),
      });
      publishStatus?.({ lifecycle: 'watching', status: refreshedStatus });

      const refreshedClassification = classifyMergeReadyWatchStatus(refreshedStatus);

      // A successful wait transition means the previous actionable blocker was cleared
      // enough to resume polling, so future same-shaped blockers should be retriable.
      if (refreshedClassification.actionability === 'wait') {
        attemptedSignatures.clear();
      }

      // After successful repair, trigger compaction if configured.
      if (
        refreshedClassification.actionability === 'wait' &&
        config.autoCompactRepair &&
        options.ctx.compact
      ) {
        try {
          setMergeReadyWatchStatus(options.ctx, 'Compacting after successful repair…');
          await options.ctx.compact({
            customInstructions:
              'Compaction triggered after successful merge-ready repair loop completion',
          });
          throwIfMergeReadyWatchAborted(options.signal);
        } catch (error) {
          if (options.signal.aborted) {
            throw createAbortError(options.signal.reason);
          }

          // Log error but don't fail the watch loop
          options.ctx.ui.notify(
            `Compaction failed after repair: ${getErrorMessage(error)}`,
            'warning',
          );
        }
      }

      if (refreshedClassification.actionability === 'repair') {
        const refreshedSignature = createMergeReadyWatchBlockerSignature(
          refreshedStatus,
          refreshedClassification.repairItems,
        );
        if (refreshedSignature === signature) {
          setMergeReadyWatchStatus(options.ctx, 'Stopped · repeated actionable blocker');
          publishStatus?.({
            lifecycle: 'stopped',
            status: refreshedStatus,
            summary: 'The same actionable blocker is still present after one attempt.',
          });
          options.ctx.ui.notify(
            `Stopping merge-ready watch for ${formatStatusTargetLabel(refreshedStatus)}: the same actionable blocker is still present after one attempt.`,
            'warning',
          );
          return {
            kind: 'stopped',
            reason: 'repeated_actionable_signature',
            status: refreshedStatus,
            signature: refreshedSignature,
          };
        }

        continue;
      }

      if (refreshedClassification.actionability === 'stop') {
        const stopOutcome = resolveMergeReadyWatchStopOutcome(
          refreshedStatus,
          refreshedClassification,
        );
        setMergeReadyWatchStatus(options.ctx, `Stopped · ${stopOutcome.message}`);
        publishStatus?.({
          lifecycle: 'stopped',
          status: refreshedStatus,
          summary: stopOutcome.message,
        });
        options.ctx.ui.notify(
          `Stopping merge-ready watch for ${formatStatusTargetLabel(refreshedStatus)}: ${stopOutcome.message}`,
          stopOutcome.level,
        );
        return { kind: 'stopped', reason: stopOutcome.reason, status: refreshedStatus };
      }

      if (
        refreshedClassification.reason === 'unknown_open_items_present' &&
        refreshedClassification.unknownItems
      ) {
        options.ctx.ui.notify(
          `Merge-ready watch: unrecognized items present (${refreshedClassification.unknownItems.map((i) => i.id).join(', ')})`,
          'warning',
        );
      }
      setMergeReadyWatchStatus(
        options.ctx,
        `Watching ${formatStatusSubject(refreshedStatus)} · ${refreshedStatus.summary}`,
      );
      await sleep(options.intervalSeconds * 1_000, options.signal);
      throwIfMergeReadyWatchAborted(options.signal);
    }
  } catch (error) {
    if (isAbortError(error)) {
      return { kind: 'aborted', reason: 'aborted' };
    }

    throw error;
  }
}

export function createMergeReadyWatchBlockerSignature(
  status: Pick<MergeReadyStatus, 'target' | 'pr'>,
  actionableItems: ReadonlyArray<MergeReadyOpenItem>,
): string {
  return JSON.stringify({
    target: normalizeMergeReadyWatchSignatureTarget(status.target),
    pr: normalizeMergeReadyWatchSignaturePullRequest(status.pr),
    items: normalizeMergeReadyWatchSignatureItems(actionableItems),
  });
}

function resolveMergeReadyWatchRepairGuidanceLines(
  actionableItems: ReadonlyArray<MergeReadyOpenItem>,
  repairGuidance: MergeReadyRepairGuidanceMap | undefined,
): string[] {
  if (repairGuidance === undefined) {
    return [];
  }

  const seen = new Set<MergeReadyOpenItemId>();
  const guidanceLines: string[] = [];

  for (const openItem of actionableItems) {
    if (seen.has(openItem.id)) {
      continue;
    }
    seen.add(openItem.id);

    const guidance = repairGuidance[openItem.id];
    if (typeof guidance !== 'string' || guidance.length === 0) {
      continue;
    }

    guidanceLines.push(`- ${openItem.id}: ${guidance}`);
  }

  return guidanceLines;
}

export function createMergeReadyWatchRepairPrompt(
  status: Pick<
    MergeReadyStatus,
    'generatedAt' | 'openItems' | 'pr' | 'signals' | 'state' | 'summary' | 'target'
  >,
  actionableItems: ReadonlyArray<MergeReadyOpenItem>,
  repairGuidance?: MergeReadyRepairGuidanceMap,
): string {
  const actionableIds = actionableItems.map((openItem) => openItem.id).join(', ');
  const guidanceLines = resolveMergeReadyWatchRepairGuidanceLines(actionableItems, repairGuidance);
  const guidanceSection =
    guidanceLines.length === 0
      ? []
      : ['', 'Configured repair guidance for the actionable item(s):', ...guidanceLines, ''];
  const snapshot = JSON.stringify(
    {
      state: status.state,
      target: status.target,
      pr: status.pr,
      summary: status.summary,
      openItems: status.openItems,
      signals: status.signals,
      generatedAt: status.generatedAt,
    },
    null,
    2,
  );

  if (status.target.mode === 'url') {
    return [
      `Use the merge-ready-loop skill for ${status.target.url}.`,
      'This was triggered by /merge-ready watch.',
      '',
      'Do this URL-targeted repair in an isolated git worktree for the PR head repo/branch. Do not mutate the ambient checkout.',
      'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair and return only a compact result to this coordinating watch turn. Do not assume any specific subagent framework.',
      "Use the snapshot's pr.headRepository and pr.headRefName to identify the editable head. If the head repository or branch is missing or cannot be fetched, stop and report the ambiguity.",
      '',
      'Work only from the openItems returned by merge_ready_status. Do not invent additional blockers. Treat openItems[].details[] as supporting provenance only.',
      ...guidanceSection,
      'Current snapshot:',
      snapshot,
      '',
      `Make one bounded repair attempt for the actionable item(s): ${actionableIds}.`,
      'Run the strongest relevant local validation you reasonably can in the worktree.',
      'Report the worktree path used, whether the patch was pushed/prepared, and whether each item is addressed locally, cleared remotely, skipped, or waiting on external confirmation.',
      'Do not wait indefinitely for remote CI/review/GitHub to clear.',
      'Do not start another watch loop.',
    ].join('\n');
  }

  return [
    `Use the merge-ready-loop skill for ${describeMergeReadyWatchRepairTarget(status)}.`,
    'This was triggered by /merge-ready watch.',
    '',
    'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair and return only a compact result to this coordinating watch turn. Do not assume any specific subagent framework.',
    '',
    'Work only from the openItems returned by merge_ready_status. Do not invent additional blockers. Treat openItems[].details[] as supporting provenance only.',
    ...guidanceSection,
    'Current snapshot:',
    snapshot,
    '',
    `Make one bounded repair attempt for the actionable item(s): ${actionableIds}.`,
    'Run the strongest relevant local validation you reasonably can.',
    'After the attempt, report whether each item is addressed locally, cleared remotely, skipped, or waiting on external confirmation.',
    'Do not wait indefinitely for remote CI/review/GitHub to clear.',
    'Do not start another watch loop.',
  ].join('\n');
}

export async function getMergeReadyWatchDirtyWorktreeState(options: {
  exec: MergeReadyExec;
  cwd: string;
  timeout?: number;
}): Promise<
  | {
      ok: true;
      dirty: boolean;
    }
  | {
      ok: false;
      message: string;
    }
> {
  const result = await runNormalizedExecCommand(
    options.exec,
    'git',
    ['status', '--porcelain=v1'],
    options.cwd,
    options.timeout,
  );

  if (!result.ok) {
    return {
      ok: false,
      message: 'unable to inspect the local git working tree with git status --porcelain=v1',
    };
  }

  return {
    ok: true,
    dirty: result.stdout.trim().length > 0,
  };
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }

  return new Promise((resolve, reject) => {
    let cleanup = () => {};
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timeout.unref?.();

    if (!signal) {
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError(signal.reason));
    };

    cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveMergeReadyWatchStopOutcome(
  status: Pick<MergeReadyStatus, 'openItems' | 'pr' | 'summary'>,
  classification: MergeReadyWatchClassification,
): MergeReadyResolvedStopOutcome {
  if (classification.reason === 'no_pull_request') {
    return {
      reason: 'no_pull_request',
      message:
        classification.stopItems.find((openItem) => openItem.id === 'no_pull_request')?.summary ??
        status.summary,
      level: 'warning',
    };
  }

  if (classification.reason === 'terminal_pull_request') {
    return {
      reason: 'terminal_pull_request',
      message: status.pr ? `PR is already ${status.pr.lifecycle}` : 'Pull request is not open',
      level: 'info',
    };
  }

  const stopItem = classification.stopItems[0];
  if (stopItem) {
    return createMergeReadyWatchStopOutcomeFromOpenItem(stopItem);
  }

  return {
    reason: 'non_actionable_open_items',
    message: status.summary,
    level: 'warning',
  };
}

function createMergeReadyWatchStopOutcomeFromOpenItem(
  openItem: MergeReadyOpenItem,
): MergeReadyResolvedStopOutcome {
  if (openItem.id === 'status_ambiguous') {
    return { reason: 'status_ambiguous', message: openItem.summary, level: 'warning' };
  }

  if (openItem.id === 'draft') {
    return { reason: 'draft', message: openItem.summary, level: 'warning' };
  }

  if (openItem.id === 'changes_requested') {
    return { reason: 'changes_requested', message: openItem.summary, level: 'warning' };
  }

  if (openItem.id === 'unresolved_conversations') {
    return { reason: 'unresolved_conversations', message: openItem.summary, level: 'warning' };
  }

  if (openItem.id === 'merge_blocked') {
    return { reason: 'merge_blocked', message: openItem.summary, level: 'warning' };
  }

  if (openItem.id === 'no_pull_request') {
    return { reason: 'no_pull_request', message: openItem.summary, level: 'warning' };
  }

  return {
    reason: 'non_actionable_open_items',
    message: openItem.summary,
    level: 'warning',
  };
}

function createMergeReadyWatchStatusPublisher(options: {
  api: Pick<MergeReadyWatchAPI, 'appendEntry' | 'events'>;
  ctx: Pick<MergeReadyWatchContext, 'session' | 'sessionManager'>;
  requestedUrl?: string;
}) {
  const session = resolveMergeReadyWatchSessionRef(options.ctx);

  return (payload: {
    lifecycle: MergeReadyWatchLifecycleState;
    status?: MergeReadyStatus | undefined;
    summary?: string | undefined;
    updatedAt?: string | undefined;
  }) =>
    publishMergeReadyWatchStatus({
      publisher: options.api,
      lifecycle: payload.lifecycle,
      status: payload.status,
      summary: payload.summary,
      updatedAt: payload.updatedAt,
      ...(options.requestedUrl === undefined ? {} : { requestedUrl: options.requestedUrl }),
      session,
    });
}

function resolveMergeReadyWatchSessionRef(
  ctx: Pick<MergeReadyWatchContext, 'session' | 'sessionManager'>,
): MergeReadyWatchSessionRef {
  const sessionId = ctx.session?.sessionId ?? ctx.sessionManager?.getSessionId?.();
  const sessionFile = ctx.session?.sessionFile ?? ctx.sessionManager?.getSessionFile?.();

  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionFile === undefined ? {} : { sessionFile }),
  };
}

function usesMergeReadyWatchStopShortcut(ctx: Pick<MergeReadyWatchContext, 'mode'>): boolean {
  return ctx.mode === undefined || ctx.mode === 'tui';
}

function resolveSendUserMessageOptions(): { deliverAs: 'followUp' } {
  return { deliverAs: 'followUp' };
}

function formatRequestedTargetLabel(url: string | undefined): string {
  return url ?? 'current branch PR';
}

function formatStatusTargetLabel(status: MergeReadyStatus): string {
  if (status.pr?.url) {
    return status.pr.url;
  }

  if (status.target.mode === 'url') {
    return `${status.target.owner}/${status.target.repo}#${String(status.target.prNumber)}`;
  }

  return status.target.branch ? `current branch ${status.target.branch}` : 'current branch';
}

function formatStatusSubject(status: MergeReadyStatus): string {
  if (status.pr) {
    return `#${String(status.pr.number)}`;
  }

  if (status.target.mode === 'url') {
    return `${status.target.owner}/${status.target.repo}#${String(status.target.prNumber)}`;
  }

  return status.target.branch ?? 'current branch';
}

function normalizeMergeReadyWatchSignatureTarget(target: MergeReadyTarget) {
  if (target.mode === 'url') {
    return {
      mode: target.mode,
      url: target.url,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
    };
  }

  return {
    mode: target.mode,
    ...(target.owner === undefined ? {} : { owner: target.owner }),
    ...(target.repo === undefined ? {} : { repo: target.repo }),
    ...(target.branch === undefined ? {} : { branch: target.branch }),
  };
}

function normalizeMergeReadyWatchSignaturePullRequest(pr: MergeReadyPullRequest | null) {
  if (pr === null) {
    return null;
  }

  return {
    lifecycle: pr.lifecycle,
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    ...(pr.headRepository === undefined ? {} : { headRepository: { ...pr.headRepository } }),
  };
}

function normalizeMergeReadyWatchSignatureItems(
  actionableItems: ReadonlyArray<MergeReadyOpenItem>,
) {
  return [...actionableItems]
    .map((openItem) => {
      const details = normalizeMergeReadyWatchSignatureDetails(openItem.details ?? []);

      return {
        id: openItem.id,
        summary: openItem.summary,
        ...(details.length === 0 ? {} : { details }),
      };
    })
    .sort((left, right) => compareMergeReadyWatchSignatureValues(left, right));
}

function normalizeMergeReadyWatchSignatureDetails(
  details: ReadonlyArray<MergeReadyOpenItemDetail>,
) {
  return [...details]
    .map((detail) => ({
      label: detail.label,
      ...(detail.status === undefined ? {} : { status: detail.status }),
      ...(detail.url === undefined ? {} : { url: detail.url }),
    }))
    .sort((left, right) => compareMergeReadyWatchSignatureValues(left, right));
}

function compareMergeReadyWatchSignatureValues(left: unknown, right: unknown): number {
  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText.localeCompare(rightText);
}

function describeMergeReadyWatchRepairTarget(
  status: Pick<MergeReadyStatus, 'pr' | 'target'>,
): string {
  if (status.target.mode === 'url') {
    return status.target.url;
  }

  return 'the current branch PR';
}

async function restoreAmbientMergeReadyStatusBar(options: {
  exec: MergeReadyExec;
  ctx: Pick<MergeReadyWatchContext, 'cwd' | 'projectTrusted' | 'ui'>;
}): Promise<void> {
  if (isMergeReadyStatusBarSuspended()) {
    return;
  }

  const setStatus = options.ctx.ui.setStatus;
  if (typeof setStatus !== 'function') {
    return;
  }

  const theme = resolveMergeReadyWatchStatusBarTheme(options.ctx);

  try {
    await refreshMergeReadyStatusBar({
      exec: options.exec,
      ctx: {
        cwd: options.ctx.cwd,
        ui: {
          setStatus,
          ...(theme === undefined ? {} : { theme }),
        },
      },
      ...(options.ctx.projectTrusted === undefined
        ? {}
        : { projectTrusted: options.ctx.projectTrusted }),
    });
  } catch {
    // Ignore best-effort ambient status-bar restore failures during watch teardown.
  }
}

function resolveMergeReadyWatchStatusBarTheme(
  ctx: Pick<MergeReadyWatchContext, 'ui'>,
): MergeReadyWatchContext['ui']['theme'] | undefined {
  try {
    return ctx.ui.theme;
  } catch {
    return undefined;
  }
}

function setMergeReadyWatchStatus(ctx: MergeReadyWatchContext, text?: string): void {
  ctx.ui.setStatus?.(
    MERGE_READY_WATCH_STATUS_KEY,
    text === undefined ? undefined : renderMergeReadyWatchStatusText(ctx, text),
  );
}

function renderMergeReadyWatchStatusText(ctx: MergeReadyWatchContext, text: string): string {
  try {
    return ctx.ui.theme?.fg('dim', text) ?? text;
  } catch {
    return text;
  }
}

function throwIfMergeReadyWatchAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError(signal.reason);
  }
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const message =
    typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'Aborted';

  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
