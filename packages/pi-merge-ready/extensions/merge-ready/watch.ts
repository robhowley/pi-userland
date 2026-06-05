import { getErrorMessage, runNormalizedExecCommand } from './internal.js';
import { getMergeReadyStatus } from './merge-ready.js';
import { syncMergeReadyStatusBar } from './status-bar.js';
import type { MergeReadyExec } from './git.js';
import type {
  MergeReadyOpenItem,
  MergeReadyOpenItemDetail,
  MergeReadyOpenItemId,
  MergeReadyPullRequest,
  MergeReadyStatus,
  MergeReadyTarget,
} from './types.js';

export const MERGE_READY_WATCH_STATUS_KEY = 'merge-ready-watch';
export const MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS = 60;
export const MERGE_READY_WATCH_MIN_INTERVAL_SECONDS = 15;
export const MERGE_READY_WATCH_MAX_INTERVAL_SECONDS = 3_600;

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
  | 'non_actionable_open_items';

export type MergeReadyWatchClassification = {
  actionability: MergeReadyWatchActionability;
  reason: MergeReadyWatchClassificationReason;
  repairItems: MergeReadyOpenItem[];
  waitItems: MergeReadyOpenItem[];
  stopItems: MergeReadyOpenItem[];
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

export type MergeReadyWatchContext = {
  cwd: string;
  isIdle?: () => boolean;
  waitForIdle?: () => Promise<void>;
  ui: {
    notify: (message: string, type?: MergeReadyWatchNotificationLevel) => void;
    setStatus?: (key: string, status?: string) => void;
    theme?: {
      fg: (color: string, text: string) => string;
    };
  };
};

export type MergeReadyWatchAPI = {
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ) => Promise<void> | void;
  on?: (
    event: 'session_shutdown',
    handler: (event: unknown, ctx: unknown) => void | Promise<void>,
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
  maxIterations?: number;
};

export type RunMergeReadyWatchLoopOptions = {
  exec: MergeReadyExec;
  api: Required<Pick<MergeReadyWatchAPI, 'sendUserMessage'>>;
  ctx: MergeReadyWatchContext;
  intervalSeconds: number;
  timeout?: number;
  signal: AbortSignal;
  url?: string;
  dependencies?: MergeReadyWatchLoopDependencies;
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

export type ActiveMergeReadyWatcher = {
  id: number;
  abortController: AbortController;
  targetLabel: string;
  startedAtMs: number;
  promise: Promise<MergeReadyWatchResult>;
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

let activeWatcher: ActiveMergeReadyWatcher | null = null;
let nextWatcherId = 1;
const pendingWatcherPromises = new Set<Promise<MergeReadyWatchResult>>();

export function registerMergeReadyWatchLifecycle(api: MergeReadyWatchAPI): void {
  api.on?.('session_shutdown', () => {
    abortActiveMergeReadyWatch();
  });
}

export function getActiveMergeReadyWatch(): ActiveMergeReadyWatcher | null {
  return activeWatcher;
}

export async function resetMergeReadyWatchState(): Promise<void> {
  abortActiveMergeReadyWatch();
  nextWatcherId = 1;
  await Promise.allSettled([...pendingWatcherPromises]);
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

  for (const openItem of status.openItems) {
    if (REPAIR_OPEN_ITEM_ID_SET.has(openItem.id)) {
      repairItems.push(openItem);
      continue;
    }

    if (WAIT_OPEN_ITEM_ID_SET.has(openItem.id)) {
      waitItems.push(openItem);
      continue;
    }

    if (!STOP_OPEN_ITEM_ID_SET.has(openItem.id)) {
      stopItems.push(openItem);
    }
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
  if (activeWatcher) {
    return {
      ok: false,
      level: 'warning',
      message: `Merge-ready watch is already active for ${activeWatcher.targetLabel}. Cancel the foreground watch before starting another.`,
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
  };
  nextWatcherId += 1;
  activeWatcher = watcher;

  const unlinkParentSignal = linkAbortSignal(options.signal, watcher.abortController);

  setMergeReadyWatchStatus(options.ctx, `Watching ${watcher.targetLabel} · starting…`);

  const promise = runMergeReadyWatchLoop({
    exec: options.exec,
    api: {
      sendUserMessage: (content, messageOptions) =>
        sendUserMessage.call(options.api, content, messageOptions),
    },
    ctx: options.ctx,
    intervalSeconds: options.intervalSeconds,
    signal: watcher.abortController.signal,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  })
    .catch((error) => {
      if (isAbortError(error)) {
        return { kind: 'aborted', reason: 'aborted' } satisfies MergeReadyWatchResult;
      }

      options.ctx.ui.notify(
        `Merge-ready watch failed for ${watcher.targetLabel}: ${getErrorMessage(error)}`,
        'error',
      );
      return { kind: 'stopped', reason: 'error' } satisfies MergeReadyWatchResult;
    })
    .finally(() => {
      unlinkParentSignal();
      pendingWatcherPromises.delete(watcher.promise);
      if (activeWatcher?.id === watcher.id) {
        activeWatcher = null;
        setMergeReadyWatchStatus(options.ctx);
      }
    });

  watcher.promise = promise;
  pendingWatcherPromises.add(promise);

  return {
    ok: true,
    level: 'info',
    message: `Watching merge readiness for ${watcher.targetLabel} every ${String(options.intervalSeconds)}s. Cancel the foreground command to stop.`,
    promise,
  };
}

function abortActiveMergeReadyWatch(ctx?: MergeReadyWatchContext): void {
  const watcher = activeWatcher;
  activeWatcher = null;
  watcher?.abortController.abort();

  if (ctx) {
    setMergeReadyWatchStatus(ctx);
  }
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
  const maxIterations = options.dependencies?.maxIterations;
  const attemptedSignatures = new Set<string>();
  let iterations = 0;

  while (!options.signal.aborted) {
    if (maxIterations !== undefined && iterations >= maxIterations) {
      return { kind: 'stopped', reason: 'max_iterations' };
    }
    iterations += 1;

    const status = await getStatus({
      exec: options.exec,
      cwd: options.ctx.cwd,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });

    if (status.target.mode !== 'url') {
      syncStatusBar({
        ctx: {
          cwd: options.ctx.cwd,
          ui: options.ctx.ui,
        },
        status,
      });
    }

    const classification = classifyMergeReadyWatchStatus(status);
    if (classification.actionability === 'stop') {
      const stopOutcome = resolveMergeReadyWatchStopOutcome(status, classification);
      setMergeReadyWatchStatus(options.ctx, `Stopped · ${stopOutcome.message}`);
      options.ctx.ui.notify(
        `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: ${stopOutcome.message}`,
        stopOutcome.level,
      );
      return { kind: 'stopped', reason: stopOutcome.reason, status };
    }

    if (classification.actionability === 'wait') {
      setMergeReadyWatchStatus(
        options.ctx,
        `Watching ${formatStatusSubject(status)} · ${status.summary} · next poll in ${String(options.intervalSeconds)}s`,
      );
      await sleep(options.intervalSeconds * 1_000, options.signal);
      continue;
    }

    const signature = createMergeReadyWatchBlockerSignature(status, classification.repairItems);
    if (attemptedSignatures.has(signature)) {
      setMergeReadyWatchStatus(options.ctx, 'Stopped · repeated actionable blocker');
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

    const dirtyState = await checkDirtyWorkingTree({
      exec: options.exec,
      cwd: options.ctx.cwd,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });
    if (!dirtyState.ok) {
      setMergeReadyWatchStatus(options.ctx, 'Stopped · git working tree preflight failed');
      options.ctx.ui.notify(
        `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: ${dirtyState.message}`,
        'warning',
      );
      return { kind: 'stopped', reason: 'dirty_check_failed', status };
    }

    if (dirtyState.dirty) {
      setMergeReadyWatchStatus(options.ctx, 'Stopped · dirty working tree');
      options.ctx.ui.notify(
        `Stopping merge-ready watch for ${formatStatusTargetLabel(status)}: local git changes are present, so auto-repair is disabled.`,
        'warning',
      );
      return { kind: 'stopped', reason: 'dirty_worktree', status };
    }

    attemptedSignatures.add(signature);
    setMergeReadyWatchStatus(
      options.ctx,
      `Repairing ${formatStatusSubject(status)} · ${classification.repairItems.map((openItem) => openItem.id).join(', ')}`,
    );
    options.ctx.ui.notify(
      `Repairing ${formatStatusTargetLabel(status)} for ${classification.repairItems.map((openItem) => openItem.id).join(', ')}.`,
      'info',
    );

    await options.api.sendUserMessage(
      createMergeReadyWatchRepairPrompt(status, classification.repairItems),
      resolveSendUserMessageOptions(options.ctx),
    );

    if (typeof options.ctx.waitForIdle === 'function') {
      await options.ctx.waitForIdle();
    }

    const refreshedStatus = await getStatus({
      exec: options.exec,
      cwd: options.ctx.cwd,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    });

    if (refreshedStatus.target.mode !== 'url') {
      syncStatusBar({
        ctx: {
          cwd: options.ctx.cwd,
          ui: options.ctx.ui,
        },
        status: refreshedStatus,
      });
    }

    const refreshedClassification = classifyMergeReadyWatchStatus(refreshedStatus);
    if (refreshedClassification.actionability === 'repair') {
      const refreshedSignature = createMergeReadyWatchBlockerSignature(
        refreshedStatus,
        refreshedClassification.repairItems,
      );
      if (refreshedSignature === signature) {
        setMergeReadyWatchStatus(options.ctx, 'Stopped · repeated actionable blocker');
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
      options.ctx.ui.notify(
        `Stopping merge-ready watch for ${formatStatusTargetLabel(refreshedStatus)}: ${stopOutcome.message}`,
        stopOutcome.level,
      );
      return { kind: 'stopped', reason: stopOutcome.reason, status: refreshedStatus };
    }

    setMergeReadyWatchStatus(
      options.ctx,
      `Watching ${formatStatusSubject(refreshedStatus)} · ${refreshedStatus.summary} · next poll in ${String(options.intervalSeconds)}s`,
    );
    await sleep(options.intervalSeconds * 1_000, options.signal);
  }

  return { kind: 'aborted', reason: 'aborted' };
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

export function createMergeReadyWatchRepairPrompt(
  status: Pick<
    MergeReadyStatus,
    'generatedAt' | 'openItems' | 'pr' | 'signals' | 'state' | 'summary' | 'target'
  >,
  actionableItems: ReadonlyArray<MergeReadyOpenItem>,
): string {
  const actionableIds = actionableItems.map((openItem) => openItem.id).join(', ');
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

  return [
    `Use the merge-ready-loop skill for ${describeMergeReadyWatchRepairTarget(status)}.`,
    'This was triggered by /merge-ready watch.',
    '',
    'Work only from the openItems returned by merge_ready_status. Do not invent additional blockers. Treat openItems[].details[] as supporting provenance only.',
    '',
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

function resolveSendUserMessageOptions(
  ctx: MergeReadyWatchContext,
): { deliverAs?: 'followUp' } | undefined {
  if (typeof ctx.isIdle === 'function' && !ctx.isIdle()) {
    return { deliverAs: 'followUp' };
  }

  return undefined;
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

function setMergeReadyWatchStatus(ctx: MergeReadyWatchContext, text?: string): void {
  ctx.ui.setStatus?.(
    MERGE_READY_WATCH_STATUS_KEY,
    text === undefined ? undefined : (ctx.ui.theme?.fg('dim', text) ?? text),
  );
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
