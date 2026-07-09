import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMergeReadyStatus,
  isMergeReadyStatusBarSuspended,
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TIMEOUT_MS,
  MERGE_READY_STATUS_BAR_TTL_MS,
  MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS,
  MERGE_READY_WATCH_MAX_INTERVAL_SECONDS,
  MERGE_READY_WATCH_MIN_INTERVAL_SECONDS,
  MERGE_READY_WATCH_STATUS_KEY,
  MERGE_READY_WATCH_STOP_SHORTCUT,
  classifyMergeReadyWatchStatus,
  createMergeReadyWatchBlockerSignature,
  createMergeReadyWatchRepairPrompt,
  getActiveMergeReadyWatch,
  parseMergeReadyWatchIntervalSeconds,
  refreshMergeReadyStatusBar,
  registerMergeReadyWatchLifecycle,
  registerMergeReadyWatchShortcut,
  resetMergeReadyStatusBarCache,
  resetMergeReadyWatchState,
  runMergeReadyWatchLoop,
  sleepWithAbort,
  startMergeReadyWatch,
  stopActiveMergeReadyWatch,
  syncMergeReadyStatusBar,
  type MergeReadyWatchContext,
  type MergeReadyOpenItem,
  type MergeReadyPullRequest,
  type MergeReadySignals,
  type MergeReadyStatus,
  type MergeReadyTarget,
  type MergeReadyWatchShortcutContext,
} from '../../extensions/merge-ready/index.js';
import {
  createCurrentBranchProbeCall,
  createFakeExec,
  CURRENT_BRANCH_TARGET,
} from './test-fixtures.js';

const GENERATED_AT = '2026-06-05T00:00:00.000Z';

const OPEN_PR: MergeReadyPullRequest = {
  lifecycle: 'open',
  number: 42,
  title: 'Add merge-ready watch helpers',
  url: 'https://github.com/robhowley/pi-userland/pull/42',
  headRefName: 'feat/merge-ready-watch',
  baseRefName: 'main',
};

const HELPER_CURRENT_BRANCH_TARGET: MergeReadyTarget = {
  mode: 'current_branch',
  owner: 'robhowley',
  repo: 'pi-userland',
  branch: 'feat/merge-ready-watch',
};

const HELPER_URL_TARGET: MergeReadyTarget = {
  mode: 'url',
  url: OPEN_PR.url,
  owner: 'robhowley',
  repo: 'pi-userland',
  prNumber: OPEN_PR.number,
};

const BASE_SIGNALS: MergeReadySignals = {
  draft: false,
  mergeability: 'mergeable',
  checks: 'passing',
  review: 'approved',
  unresolvedConversations: false,
  unresolvedConversationRequirement: 'optional',
};

type RuntimeUrlTarget = Extract<MergeReadyTarget, { mode: 'url' }>;

const RUNTIME_URL_TARGET: RuntimeUrlTarget = {
  mode: 'url',
  url: 'https://github.com/shopify/pi/pull/64',
  owner: 'shopify',
  repo: 'pi',
  prNumber: 64,
};

const SECOND_RUNTIME_URL_TARGET: RuntimeUrlTarget = {
  mode: 'url',
  url: 'https://github.com/shopify/pi/pull/65',
  owner: 'shopify',
  repo: 'pi',
  prNumber: 65,
};

function buildOpenItem(
  id: MergeReadyOpenItem['id'],
  overrides: Partial<MergeReadyOpenItem> = {},
): MergeReadyOpenItem {
  return {
    id,
    summary: overrides.summary ?? id,
    ...(overrides.details === undefined ? {} : { details: overrides.details }),
  };
}

function buildStatus(
  overrides: Partial<MergeReadyStatus> & {
    openItems?: MergeReadyOpenItem[];
    pr?: MergeReadyPullRequest | null;
    target?: MergeReadyTarget;
  } = {},
): MergeReadyStatus {
  return {
    state: overrides.state ?? 'ready',
    target: overrides.target ?? HELPER_CURRENT_BRANCH_TARGET,
    pr: overrides.pr === undefined ? OPEN_PR : overrides.pr,
    summary: overrides.summary ?? 'Ready to merge',
    openItems: overrides.openItems ?? [],
    signals: overrides.signals ?? BASE_SIGNALS,
    generatedAt: overrides.generatedAt ?? GENERATED_AT,
  };
}

function buildRuntimeOpenPr(overrides: Partial<NonNullable<MergeReadyStatus['pr']>> = {}) {
  return {
    lifecycle: 'open' as const,
    number: 42,
    title: 'Compose merge-ready status boundary',
    url: 'https://github.com/robhowley/pi-userland/pull/42',
    headRefName: 'feat/merge-ready',
    baseRefName: 'main',
    ...overrides,
  };
}

function buildRuntimeUrlOpenPr(
  target: RuntimeUrlTarget = RUNTIME_URL_TARGET,
  overrides: Partial<NonNullable<MergeReadyStatus['pr']>> = {},
) {
  return buildRuntimeOpenPr({
    number: target.prNumber,
    title:
      target.prNumber === RUNTIME_URL_TARGET.prNumber
        ? 'Support explicit PR URL targets'
        : `Support explicit PR URL target #${String(target.prNumber)}`,
    url: target.url,
    headRefName:
      target.prNumber === RUNTIME_URL_TARGET.prNumber
        ? 'feat/explicit-pr-url'
        : `feat/explicit-pr-url-${String(target.prNumber)}`,
    headRepository: {
      owner: target.owner,
      repo: target.repo,
    },
    ...overrides,
  });
}

function createReadyStatus(overrides: Partial<MergeReadyStatus> = {}): MergeReadyStatus {
  return {
    ...createMergeReadyStatus({
      generatedAt: GENERATED_AT,
      target: CURRENT_BRANCH_TARGET,
      pr: buildRuntimeOpenPr(),
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'passing',
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    }),
    ...overrides,
  };
}

function createCiFailingStatus(): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: CURRENT_BRANCH_TARGET,
    pr: buildRuntimeOpenPr(),
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'failing',
      checkDetails: {
        failing: [{ label: 'ci / unit', status: 'failing' }],
        running: [],
        unknown: [],
      },
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createCiRunningStatus(overrides: Partial<MergeReadyStatus> = {}): MergeReadyStatus {
  return {
    ...createMergeReadyStatus({
      generatedAt: GENERATED_AT,
      target: CURRENT_BRANCH_TARGET,
      pr: buildRuntimeOpenPr(),
      signals: {
        draft: false,
        mergeability: 'mergeable',
        checks: 'running',
        checkDetails: {
          failing: [],
          running: [{ label: 'ci / unit', status: 'running' }],
          unknown: [],
        },
        review: 'approved',
        unresolvedConversations: false,
        unresolvedConversationRequirement: 'optional',
      },
    }),
    ...overrides,
  };
}

function createUrlCiFailingStatus(target: RuntimeUrlTarget = RUNTIME_URL_TARGET): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target,
    pr: buildRuntimeUrlOpenPr(target),
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'failing',
      checkDetails: {
        failing: [{ label: 'ci / unit', status: 'failing' }],
        running: [],
        unknown: [],
      },
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createUrlCiRunningStatus(target: RuntimeUrlTarget = RUNTIME_URL_TARGET): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target,
    pr: buildRuntimeUrlOpenPr(target),
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'running',
      checkDetails: {
        failing: [],
        running: [{ label: 'ci / unit', status: 'running' }],
        unknown: [],
      },
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createUrlReadyStatus(target: RuntimeUrlTarget = RUNTIME_URL_TARGET): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target,
    pr: buildRuntimeUrlOpenPr(target),
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createNoPullRequestStatus(): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: CURRENT_BRANCH_TARGET,
    pr: null,
    summary: 'No pull request found',
    openItems: [{ id: 'no_pull_request', summary: 'No pull request found' }],
  });
}

function createStatusAmbiguousStatus(): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: CURRENT_BRANCH_TARGET,
    pr: buildRuntimeOpenPr(),
    openItems: [{ id: 'status_ambiguous', summary: 'Merge readiness is ambiguous' }],
    summary: 'Merge readiness is ambiguous',
  });
}

function createWatchContext(
  options: {
    sessionId?: string;
    sessionFile?: string;
    projectTrusted?: boolean;
  } = {},
): MergeReadyWatchContext {
  const { sessionId, sessionFile } = options;
  const sessionManager =
    sessionId === undefined && sessionFile === undefined
      ? undefined
      : {
          ...(sessionId === undefined ? {} : { getSessionId: () => sessionId }),
          ...(sessionFile === undefined ? {} : { getSessionFile: () => sessionFile }),
        };

  return {
    cwd: '/repo',
    isIdle: vi.fn(() => true),
    waitForIdle: vi.fn(async () => undefined),
    ...(options.projectTrusted === undefined ? {} : { projectTrusted: options.projectTrusted }),
    ...(sessionManager === undefined ? {} : { sessionManager }),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

function createShortcutContext(
  options: { idle?: boolean; pendingMessages?: boolean } = {},
): MergeReadyWatchShortcutContext & { abort: ReturnType<typeof vi.fn> } {
  return {
    isIdle: vi.fn(() => options.idle ?? true),
    hasPendingMessages: vi.fn(() => options.pendingMessages ?? false),
    abort: vi.fn(),
  };
}

function createStatusSequence(statuses: MergeReadyStatus[]) {
  let index = 0;
  return vi.fn(async (_options?: unknown) => statuses[Math.min(index++, statuses.length - 1)]!);
}

function createAbortableSleep() {
  return vi.fn((_ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }

    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createControlledAbortableSleep() {
  const pending: Array<ReturnType<typeof createDeferred<void>>> = [];

  const sleep = vi.fn((_ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }

    const deferred = createDeferred<void>();
    const onAbort = () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      deferred.reject(error);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    pending.push(deferred);

    return deferred.promise.finally(() => {
      signal?.removeEventListener('abort', onAbort);
      const index = pending.indexOf(deferred);
      if (index >= 0) pending.splice(index, 1);
    });
  });

  return {
    sleep,
    resolveNext: () => pending.shift()?.resolve(),
    rejectNext: (error?: unknown) => pending.shift()?.reject(error),
  };
}

type WatchLifecycleEvent = 'session_shutdown' | 'agent_end';

function createWatchLifecycleAPI(sendUserMessage: ReturnType<typeof vi.fn>) {
  const handlers = new Map<WatchLifecycleEvent, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    sendUserMessage,
    on: vi.fn((event: WatchLifecycleEvent, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    }),
  };

  return {
    api,
    getHandler: (event: WatchLifecycleEvent) => handlers.get(event),
  };
}

function createWatchShortcutAPI() {
  const handlers = new Map<string, (ctx: MergeReadyWatchShortcutContext) => Promise<void> | void>();
  const api = {
    registerShortcut: vi.fn(
      (
        shortcut: string,
        options: {
          description?: string;
          handler: (ctx: MergeReadyWatchShortcutContext) => Promise<void> | void;
        },
      ) => {
        handlers.set(shortcut, options.handler);
      },
    ),
  };

  return {
    api,
    getHandler: (shortcut: string) => handlers.get(shortcut),
  };
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

describe('merge-ready watch helpers', () => {
  describe('interval helpers', () => {
    it('exports the watch status key and interval defaults', () => {
      expect(MERGE_READY_WATCH_STATUS_KEY).toBe('merge-ready-watch');
      expect(MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS).toBe(60);
      expect(MERGE_READY_WATCH_MIN_INTERVAL_SECONDS).toBe(15);
      expect(MERGE_READY_WATCH_MAX_INTERVAL_SECONDS).toBe(3_600);
    });

    it('parses a missing interval as the default interval', () => {
      expect(parseMergeReadyWatchIntervalSeconds(undefined)).toEqual({
        ok: true,
        value: MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS,
      });
    });

    it.each([
      { input: '30', expected: { ok: true, value: 30 } },
      {
        input: '14',
        expected: {
          ok: false,
          message: `Watch interval must be at least ${String(MERGE_READY_WATCH_MIN_INTERVAL_SECONDS)} seconds.`,
        },
      },
      {
        input: String(MERGE_READY_WATCH_MAX_INTERVAL_SECONDS + 1),
        expected: {
          ok: false,
          message: `Watch interval must be at most ${String(MERGE_READY_WATCH_MAX_INTERVAL_SECONDS)} seconds.`,
        },
      },
      {
        input: '15.5',
        expected: {
          ok: false,
          message: 'Watch interval must be a whole number of seconds.',
        },
      },
    ])('parses $input', ({ input, expected }) => {
      expect(parseMergeReadyWatchIntervalSeconds(input)).toEqual(expected);
    });
  });

  describe('classifyMergeReadyWatchStatus', () => {
    it.each([
      {
        name: 'waits while ready with no open items',
        status: buildStatus(),
        expected: {
          actionability: 'wait',
          reason: 'ready',
          repairItems: [],
          waitItems: [],
          stopItems: [],
        },
      },
      {
        name: 'waits for running checks',
        status: buildStatus({
          state: 'pending',
          summary: 'Checks are still running',
          openItems: [buildOpenItem('ci_running')],
        }),
        expected: {
          actionability: 'wait',
          reason: 'wait_only_open_items',
          repairItems: [],
          waitItems: ['ci_running'],
          stopItems: [],
        },
      },
      {
        name: 'waits for pending review',
        status: buildStatus({
          state: 'pending',
          summary: 'Waiting for review',
          openItems: [buildOpenItem('review_pending')],
        }),
        expected: {
          actionability: 'wait',
          reason: 'wait_only_open_items',
          repairItems: [],
          waitItems: ['review_pending'],
          stopItems: [],
        },
      },
      {
        name: 'repairs locally actionable blockers',
        status: buildStatus({
          state: 'blocked',
          summary: 'Branch is out of date with base',
          openItems: [buildOpenItem('branch_out_of_date')],
        }),
        expected: {
          actionability: 'repair',
          reason: 'repairable_open_items',
          repairItems: ['branch_out_of_date'],
          waitItems: [],
          stopItems: [],
        },
      },
      {
        name: 'repairs actionable blockers before wait-only items',
        status: buildStatus({
          state: 'blocked',
          summary: 'Required checks are failing',
          openItems: [buildOpenItem('ci_failing'), buildOpenItem('ci_running')],
        }),
        expected: {
          actionability: 'repair',
          reason: 'repairable_open_items',
          repairItems: ['ci_failing'],
          waitItems: ['ci_running'],
          stopItems: [],
        },
      },
      {
        name: 'stops for external-only blockers',
        status: buildStatus({
          state: 'blocked',
          summary: 'GitHub reports merge is blocked',
          openItems: [buildOpenItem('merge_blocked')],
        }),
        expected: {
          actionability: 'stop',
          reason: 'non_actionable_open_items',
          repairItems: [],
          waitItems: [],
          stopItems: ['merge_blocked'],
        },
      },
      {
        name: 'stop beats repair when a non-actionable blocker is present',
        status: buildStatus({
          state: 'blocked',
          summary: 'Required checks are failing',
          openItems: [buildOpenItem('changes_requested'), buildOpenItem('ci_failing')],
        }),
        expected: {
          actionability: 'stop',
          reason: 'non_actionable_open_items',
          repairItems: ['ci_failing'],
          waitItems: [],
          stopItems: ['changes_requested'],
        },
      },
      {
        name: 'stops when there is no pull request',
        status: buildStatus({
          state: 'unknown',
          pr: null,
          summary: 'No pull request found',
          openItems: [buildOpenItem('no_pull_request')],
        }),
        expected: {
          actionability: 'stop',
          reason: 'no_pull_request',
          repairItems: [],
          waitItems: [],
          stopItems: ['no_pull_request'],
        },
      },
      {
        name: 'preserves ambiguous status when PR discovery failed',
        status: buildStatus({
          state: 'unknown',
          pr: null,
          summary: 'Merge readiness is ambiguous',
          openItems: [buildOpenItem('status_ambiguous')],
        }),
        expected: {
          actionability: 'stop',
          reason: 'non_actionable_open_items',
          repairItems: [],
          waitItems: [],
          stopItems: ['status_ambiguous'],
        },
      },
      {
        name: 'stops for terminal pull request lifecycles',
        status: buildStatus({
          state: 'unknown',
          pr: { ...OPEN_PR, lifecycle: 'closed' },
          openItems: [],
          summary: 'PR is closed',
        }),
        expected: {
          actionability: 'stop',
          reason: 'terminal_pull_request',
          repairItems: [],
          waitItems: [],
          stopItems: [],
        },
      },
      {
        name: 'stops for unknown empty open states',
        status: buildStatus({
          state: 'unknown',
          openItems: [],
          summary: 'Merge readiness is ambiguous',
        }),
        expected: {
          actionability: 'stop',
          reason: 'non_actionable_open_items',
          repairItems: [],
          waitItems: [],
          stopItems: [],
        },
      },
    ])('$name', ({ status, expected }) => {
      const classification = classifyMergeReadyWatchStatus(status);

      expect(classification.actionability).toBe(expected.actionability);
      expect(classification.reason).toBe(expected.reason);
      expect(classification.repairItems.map((openItem) => openItem.id)).toEqual(
        expected.repairItems,
      );
      expect(classification.waitItems.map((openItem) => openItem.id)).toEqual(expected.waitItems);
      expect(classification.stopItems.map((openItem) => openItem.id)).toEqual(expected.stopItems);
    });
  });

  describe('createMergeReadyWatchBlockerSignature', () => {
    it('ignores generatedAt, actionable item ordering, and detail ordering', () => {
      const firstStatus = buildStatus({
        generatedAt: GENERATED_AT,
        target: HELPER_URL_TARGET,
        state: 'blocked',
      });
      const secondStatus = buildStatus({
        generatedAt: '2026-06-05T00:05:00.000Z',
        target: HELPER_URL_TARGET,
        state: 'blocked',
      });

      const firstItems = [
        buildOpenItem('ci_failing', {
          summary: 'Required checks are failing',
          details: [
            { label: 'unit', status: 'failing', url: 'https://ci.example/unit' },
            { label: 'lint', status: 'failing', url: 'https://ci.example/lint' },
          ],
        }),
        buildOpenItem('branch_out_of_date', {
          summary: 'Branch is out of date with base',
        }),
      ];
      const secondItems = [
        buildOpenItem('branch_out_of_date', {
          summary: 'Branch is out of date with base',
        }),
        buildOpenItem('ci_failing', {
          summary: 'Required checks are failing',
          details: [
            { label: 'lint', status: 'failing', url: 'https://ci.example/lint' },
            { label: 'unit', status: 'failing', url: 'https://ci.example/unit' },
          ],
        }),
      ];

      expect(createMergeReadyWatchBlockerSignature(firstStatus, firstItems)).toBe(
        createMergeReadyWatchBlockerSignature(secondStatus, secondItems),
      );
    });

    it('changes when actionable item content changes', () => {
      const status = buildStatus({ target: HELPER_URL_TARGET, state: 'blocked' });
      const firstItems = [
        buildOpenItem('ci_failing', {
          summary: 'Required checks are failing',
          details: [{ label: 'lint', status: 'failing', url: 'https://ci.example/lint' }],
        }),
      ];
      const secondItems = [
        buildOpenItem('ci_failing', {
          summary: 'Required checks are failing',
          details: [{ label: 'test', status: 'failing', url: 'https://ci.example/lint' }],
        }),
      ];

      expect(createMergeReadyWatchBlockerSignature(status, firstItems)).not.toBe(
        createMergeReadyWatchBlockerSignature(status, secondItems),
      );
    });

    it('includes target and pull request identity', () => {
      const firstStatus = buildStatus({ target: HELPER_URL_TARGET, state: 'blocked' });
      const secondStatus = buildStatus({
        target: {
          mode: 'url',
          url: 'https://github.com/robhowley/pi-userland/pull/43',
          owner: 'robhowley',
          repo: 'pi-userland',
          prNumber: 43,
        },
        pr: {
          ...OPEN_PR,
          number: 43,
          url: 'https://github.com/robhowley/pi-userland/pull/43',
        },
        state: 'blocked',
      });
      const items = [buildOpenItem('merge_conflicts', { summary: 'Merge conflicts detected' })];

      expect(createMergeReadyWatchBlockerSignature(firstStatus, items)).not.toBe(
        createMergeReadyWatchBlockerSignature(secondStatus, items),
      );
    });
  });

  describe('createMergeReadyWatchRepairPrompt', () => {
    it('builds a bounded merge-ready-loop prompt from the current snapshot', () => {
      const status = buildStatus({
        state: 'blocked',
        summary: 'Required checks are failing',
        openItems: [
          buildOpenItem('ci_failing', {
            summary: 'Required checks are failing',
            details: [{ label: 'lint', status: 'failing', url: 'https://ci.example/lint' }],
          }),
          buildOpenItem('ci_running', {
            summary: 'Checks are still running',
          }),
        ],
      });
      const prompt = createMergeReadyWatchRepairPrompt(status, [status.openItems[0]!]);

      expect(prompt).toContain('Use the merge-ready-loop skill for the current branch PR.');
      expect(prompt).toContain('This was triggered by /merge-ready watch.');
      expect(prompt).toContain(
        'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair',
      );
      expect(prompt).toContain('Do not assume any specific subagent framework.');
      expect(prompt).toContain('Work only from the openItems returned by merge_ready_status.');
      expect(prompt).toContain('Treat openItems[].details[] as supporting provenance only.');
      expect(prompt).toContain('Current snapshot:');
      expect(prompt).toContain('"id": "ci_failing"');
      expect(prompt).toContain(
        'Make one bounded repair attempt for the actionable item(s): ci_failing.',
      );
      expect(prompt).toContain('Run the strongest relevant local validation you reasonably can.');
      expect(prompt).toContain('Do not wait indefinitely for remote CI/review/GitHub to clear.');
      expect(prompt).toContain('Do not start another watch loop.');
      expect(prompt).not.toContain('isolated git worktree');
      expect(prompt).not.toContain('Do this URL-targeted repair');
      expect(prompt).toContain(`"generatedAt": "${GENERATED_AT}"`);
    });

    it('builds an isolated-worktree prompt for URL-targeted repair', () => {
      const status = buildStatus({
        target: HELPER_URL_TARGET,
        pr: {
          ...OPEN_PR,
          headRepository: {
            owner: 'robhowley',
            repo: 'pi-userland',
          },
        },
        state: 'blocked',
        summary: 'Required checks are failing',
        openItems: [
          buildOpenItem('ci_failing', {
            summary: 'Required checks are failing',
            details: [{ label: 'lint', status: 'failing', url: 'https://ci.example/lint' }],
          }),
        ],
      });
      const prompt = createMergeReadyWatchRepairPrompt(status, status.openItems);

      expect(prompt).toContain(`Use the merge-ready-loop skill for ${HELPER_URL_TARGET.url}.`);
      expect(prompt).toContain('This was triggered by /merge-ready watch.');
      expect(prompt).toContain('Do this URL-targeted repair in an isolated git worktree');
      expect(prompt).toContain(
        'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair',
      );
      expect(prompt).toContain('Do not assume any specific subagent framework.');
      expect(prompt).toContain('Do not mutate the ambient checkout.');
      expect(prompt).toContain("Use the snapshot's pr.headRepository and pr.headRefName");
      expect(prompt).toContain(
        'If the head repository or branch is missing or cannot be fetched, stop and report the ambiguity.',
      );
      expect(prompt).toContain(
        'Run the strongest relevant local validation you reasonably can in the worktree.',
      );
      expect(prompt).toContain(
        'Report the worktree path used, whether the patch was pushed/prepared',
      );
      expect(prompt).toContain('Do not wait indefinitely for remote CI/review/GitHub to clear.');
      expect(prompt).toContain('Do not start another watch loop.');
      expect(prompt).toContain('"headRepository": {');
    });
  });

  describe('sleepWithAbort', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resolves after the requested delay', async () => {
      const onResolved = vi.fn();
      const promise = sleepWithAbort(1_000).then(onResolved);

      await vi.advanceTimersByTimeAsync(999);
      expect(onResolved).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('rejects with an abort error when aborted', async () => {
      const controller = new AbortController();
      const promise = sleepWithAbort(1_000, controller.signal);

      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});

describe('merge-ready watch shortcut', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await resetMergeReadyWatchState();
    vi.useRealTimers();
  });

  it('registers Ctrl-Shift-S as the stop shortcut', () => {
    const { api, getHandler } = createWatchShortcutAPI();

    registerMergeReadyWatchShortcut(api);

    expect(api.registerShortcut).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STOP_SHORTCUT,
      expect.objectContaining({
        description: 'Stop active merge-ready watch',
        handler: expect.any(Function),
      }),
    );
    expect(getHandler(MERGE_READY_WATCH_STOP_SHORTCUT)).toEqual(expect.any(Function));
  });

  it('silently no-ops when the shortcut fires with no active watch', async () => {
    const { api, getHandler } = createWatchShortcutAPI();
    registerMergeReadyWatchShortcut(api);
    const handler = getHandler(MERGE_READY_WATCH_STOP_SHORTCUT);
    const shortcutCtx = createShortcutContext({ idle: false, pendingMessages: true });

    await handler?.(shortcutCtx);

    expect(getActiveMergeReadyWatch()).toBeNull();
    expect(shortcutCtx.abort).not.toHaveBeenCalled();
    expect(stopActiveMergeReadyWatch()).toEqual({ stopped: false });
  });

  it('stops an active watch without aborting an idle session', async () => {
    const ctx = createWatchContext();
    const { api, getHandler } = createWatchShortcutAPI();
    const watchApi = Object.assign(api, {
      sendUserMessage: vi.fn(async () => undefined),
    });
    registerMergeReadyWatchShortcut(watchApi);
    const handler = getHandler(MERGE_READY_WATCH_STOP_SHORTCUT);

    const start = startMergeReadyWatch({
      api: watchApi,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus: createStatusSequence([createReadyStatus()]),
        sleep: createAbortableSleep(),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: false }),
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();
    expect(getActiveMergeReadyWatch()).not.toBeNull();

    const shortcutCtx = createShortcutContext();
    await handler?.(shortcutCtx);

    expect(shortcutCtx.abort).not.toHaveBeenCalled();
    expect(getActiveMergeReadyWatch()).toBeNull();
    expect(stopActiveMergeReadyWatch()).toEqual({ stopped: false });
    await expect(start.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
  });

  it('aborts the session when the shortcut fires during non-idle active watch work', async () => {
    const ctx = createWatchContext();
    const { api, getHandler } = createWatchShortcutAPI();
    const watchApi = Object.assign(api, {
      sendUserMessage: vi.fn(async () => undefined),
    });
    registerMergeReadyWatchShortcut(watchApi);
    const handler = getHandler(MERGE_READY_WATCH_STOP_SHORTCUT);

    const start = startMergeReadyWatch({
      api: watchApi,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus: createStatusSequence([createReadyStatus()]),
        sleep: createAbortableSleep(),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: false }),
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();
    expect(getActiveMergeReadyWatch()).not.toBeNull();

    const shortcutCtx = createShortcutContext({ idle: false, pendingMessages: false });
    await handler?.(shortcutCtx);

    expect(shortcutCtx.abort).toHaveBeenCalledTimes(1);
    expect(getActiveMergeReadyWatch()).toBeNull();
    expect(stopActiveMergeReadyWatch()).toEqual({ stopped: false });
    await expect(start.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
  });

  it('stops a repair_queued watch and aborts pending repair work', async () => {
    const ctx = createWatchContext();
    const { api, getHandler } = createWatchShortcutAPI();
    const watchApi = Object.assign(api, {
      sendUserMessage: vi.fn(
        async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
      ),
    });
    registerMergeReadyWatchShortcut(watchApi);
    const handler = getHandler(MERGE_READY_WATCH_STOP_SHORTCUT);

    const start = startMergeReadyWatch({
      api: watchApi,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus: createStatusSequence([createCiFailingStatus()]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: false }),
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();
    expect(getActiveMergeReadyWatch()?.phase).toBe('repair_queued');

    const shortcutCtx = createShortcutContext({ pendingMessages: true });
    await handler?.(shortcutCtx);

    expect(shortcutCtx.abort).toHaveBeenCalledTimes(1);
    expect(getActiveMergeReadyWatch()).toBeNull();
    expect(stopActiveMergeReadyWatch()).toEqual({ stopped: false });
    await expect(start.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
  });
});

describe('merge-ready watch loop', () => {
  beforeEach(() => {
    resetMergeReadyStatusBarCache();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await resetMergeReadyWatchState();
    resetMergeReadyStatusBarCache();
    vi.useRealTimers();
  });

  it('allows only one active foreground watcher per runtime owner', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const api = { sendUserMessage };
    const sleep = createAbortableSleep();

    const firstStart = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus: createStatusSequence([createReadyStatus()]),
        sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: false }),
      },
    });
    const secondStart = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
    });

    expect(firstStart).toMatchObject({ ok: true, level: 'info' });
    expect(secondStart).toEqual({
      ok: false,
      level: 'warning',
      message:
        'Merge-ready watch is already active for current branch PR. Press Ctrl-Shift-S to stop it before starting another.',
    });

    await resetMergeReadyWatchState();
    if (firstStart.ok) {
      await firstStart.promise;
    }
  });

  it('allows different runtime owners to watch different PRs concurrently and stop independently', async () => {
    const firstCtx = createWatchContext({
      sessionId: 'watch-session-a',
      sessionFile: '/tmp/watch-session-a.jsonl',
    });
    const secondCtx = createWatchContext({
      sessionId: 'watch-session-b',
      sessionFile: '/tmp/watch-session-b.jsonl',
    });
    const firstApi = {
      sendUserMessage: vi.fn(
        async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
      ),
    };
    const secondApi = {
      sendUserMessage: vi.fn(
        async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
      ),
    };
    const sleep = createAbortableSleep();

    const firstStart = startMergeReadyWatch({
      api: firstApi,
      ctx: firstCtx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([createUrlReadyStatus(RUNTIME_URL_TARGET)]),
        sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
      },
    });
    const secondStart = startMergeReadyWatch({
      api: secondApi,
      ctx: secondCtx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: SECOND_RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([createUrlReadyStatus(SECOND_RUNTIME_URL_TARGET)]),
        sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
      },
    });

    expect(firstStart).toMatchObject({ ok: true, level: 'info' });
    expect(secondStart).toMatchObject({ ok: true, level: 'info' });
    if (!firstStart.ok || !secondStart.ok) {
      return;
    }

    await flushMicrotasks();

    expect(getActiveMergeReadyWatch(firstApi)).toMatchObject({
      targetLabel: RUNTIME_URL_TARGET.url,
      phase: 'watching',
    });
    expect(getActiveMergeReadyWatch(secondApi)).toMatchObject({
      targetLabel: SECOND_RUNTIME_URL_TARGET.url,
      phase: 'watching',
    });
    expect(getActiveMergeReadyWatch()).toBeNull();

    expect(stopActiveMergeReadyWatch(firstApi)).toEqual({
      stopped: true,
      targetLabel: RUNTIME_URL_TARGET.url,
      phase: 'watching',
    });
    expect(getActiveMergeReadyWatch(firstApi)).toBeNull();
    expect(getActiveMergeReadyWatch(secondApi)).toMatchObject({
      targetLabel: SECOND_RUNTIME_URL_TARGET.url,
      phase: 'watching',
    });

    await expect(firstStart.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });

    expect(stopActiveMergeReadyWatch(secondApi)).toEqual({
      stopped: true,
      targetLabel: SECOND_RUNTIME_URL_TARGET.url,
      phase: 'watching',
    });
    await expect(secondStart.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
  });

  it('scopes agent_end resolution to the owning runtime when multiple repair turns are queued', async () => {
    const firstCtx = createWatchContext({
      sessionId: 'watch-session-a',
      sessionFile: '/tmp/watch-session-a.jsonl',
    });
    const secondCtx = createWatchContext({
      sessionId: 'watch-session-b',
      sessionFile: '/tmp/watch-session-b.jsonl',
    });
    const firstSleep = createControlledAbortableSleep();
    const secondSleep = createControlledAbortableSleep();
    const { api: firstApi, getHandler: getFirstHandler } = createWatchLifecycleAPI(
      vi.fn(async () => undefined),
    );
    const { api: secondApi, getHandler: getSecondHandler } = createWatchLifecycleAPI(
      vi.fn(async () => undefined),
    );
    registerMergeReadyWatchLifecycle(firstApi);
    registerMergeReadyWatchLifecycle(secondApi);

    const firstStart = startMergeReadyWatch({
      api: firstApi,
      ctx: firstCtx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([
          createUrlCiFailingStatus(RUNTIME_URL_TARGET),
          createUrlCiRunningStatus(RUNTIME_URL_TARGET),
        ]),
        sleep: firstSleep.sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        maxIterations: 1,
      },
    });
    const secondStart = startMergeReadyWatch({
      api: secondApi,
      ctx: secondCtx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: SECOND_RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([
          createUrlCiFailingStatus(SECOND_RUNTIME_URL_TARGET),
          createUrlCiRunningStatus(SECOND_RUNTIME_URL_TARGET),
        ]),
        sleep: secondSleep.sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        maxIterations: 1,
      },
    });

    expect(firstStart).toMatchObject({ ok: true, level: 'info' });
    expect(secondStart).toMatchObject({ ok: true, level: 'info' });
    if (!firstStart.ok || !secondStart.ok) {
      return;
    }

    await flushMicrotasks();
    expect(getActiveMergeReadyWatch(firstApi)?.phase).toBe('repair_queued');
    expect(getActiveMergeReadyWatch(secondApi)?.phase).toBe('repair_queued');

    await getFirstHandler('agent_end')?.({}, undefined);
    await flushMicrotasks();

    expect(getActiveMergeReadyWatch(firstApi)?.phase).toBe('watching');
    expect(getActiveMergeReadyWatch(secondApi)?.phase).toBe('repair_queued');

    firstSleep.resolveNext();
    await expect(firstStart.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
    });

    await getSecondHandler('agent_end')?.({}, undefined);
    await flushMicrotasks();

    expect(getActiveMergeReadyWatch(secondApi)?.phase).toBe('watching');

    secondSleep.resolveNext();
    await expect(secondStart.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
    });
  });

  it('requires repair handoff support for URL watches because they may auto-repair', () => {
    const ctx = createWatchContext();

    const start = startMergeReadyWatch({
      api: {},
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: RUNTIME_URL_TARGET.url,
    });

    expect(start).toEqual({
      ok: false,
      level: 'error',
      message: 'Merge-ready watch requires Pi sendUserMessage support.',
    });
  });

  it('falls back to plain watch status text when theme access throws', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );

    Object.defineProperty(ctx.ui, 'theme', {
      configurable: true,
      get: () => {
        throw new Error('Theme not initialized. Call initTheme() first.');
      },
    });

    const start = startMergeReadyWatch({
      api: { sendUserMessage },
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([createUrlReadyStatus()]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        maxIterations: 1,
      },
    });

    expect(start).toMatchObject({ ok: true, level: 'info' });
    if (!start.ok) {
      return;
    }

    await expect(start.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
    });
    expect(vi.mocked(ctx.ui.notify)).not.toHaveBeenCalledWith(
      expect.stringContaining('Theme not initialized. Call initTheme() first.'),
      'error',
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      `Watching ${RUNTIME_URL_TARGET.url} · starting…`,
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      'Watching #64 · Ready to merge',
    );
  });

  it.each([
    { name: 'wait-only', status: createUrlCiRunningStatus() },
    { name: 'ready', status: createUrlReadyStatus() },
  ])('keeps URL $name states polling without repair', async ({ status }) => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const checkDirtyWorkingTree = vi.fn(async () => ({ ok: true as const, dirty: false }));

    const result = await runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: { sendUserMessage },
      ctx,
      intervalSeconds: 30,
      signal: new AbortController().signal,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([status]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree,
        maxIterations: 1,
      },
    });

    expect(result).toMatchObject({ kind: 'stopped', reason: 'max_iterations' });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining(`Watching #64 · ${status.summary}`),
    );
    expect(
      vi
        .mocked(ctx.ui.setStatus!)
        .mock.calls.filter(([key]) => key === MERGE_READY_WATCH_STATUS_KEY)
        .some(([, value]) => typeof value === 'string' && value.includes('next poll')),
    ).toBe(false);
  });

  it('aborts before sync or repair side effects when cancellation lands during the status poll', async () => {
    const ctx = createWatchContext();
    const abortController = new AbortController();
    const statusPoll = createDeferred<MergeReadyStatus>();
    const syncStatusBar = vi.fn();
    const checkDirtyWorkingTree = vi.fn(async () => ({ ok: true as const, dirty: false }));
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );

    const result = runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: { sendUserMessage },
      ctx,
      intervalSeconds: 30,
      signal: abortController.signal,
      dependencies: {
        getStatus: vi.fn(() => statusPoll.promise),
        sleep: vi.fn(async () => undefined),
        syncStatusBar,
        checkDirtyWorkingTree,
      },
    });

    abortController.abort();
    statusPoll.resolve(createCiFailingStatus());

    await expect(result).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    expect(syncStatusBar).not.toHaveBeenCalled();
    expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify)).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.setStatus)).not.toHaveBeenCalled();
  });

  it('aborts before repair side effects when cancellation lands during dirty-worktree preflight', async () => {
    const ctx = createWatchContext();
    const abortController = new AbortController();
    const dirtyPreflight = createDeferred<{ ok: true; dirty: false }>();
    const getStatus = vi.fn(async () => createCiFailingStatus());
    const syncStatusBar = vi.fn();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );

    const result = runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: { sendUserMessage },
      ctx,
      intervalSeconds: 30,
      signal: abortController.signal,
      dependencies: {
        getStatus,
        sleep: vi.fn(async () => undefined),
        syncStatusBar,
        checkDirtyWorkingTree: vi.fn(() => dirtyPreflight.promise),
      },
    });

    await Promise.resolve();
    abortController.abort();
    dirtyPreflight.resolve({ ok: true, dirty: false });

    await expect(result).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(syncStatusBar).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.waitForIdle)).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify)).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.setStatus)).not.toHaveBeenCalled();
  });

  it('queues one follow-up repair for ci_failing, waits for agent_end, then refreshes once into polling', async () => {
    const ctx = createWatchContext();
    const getStatus = createStatusSequence([createCiFailingStatus(), createCiRunningStatus()]);
    const { sleep, resolveNext } = createControlledAbortableSleep();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const syncStatusBar = vi.fn();
    const checkDirtyWorkingTree = vi.fn(async () => ({ ok: true as const, dirty: false }));
    const { api, getHandler } = createWatchLifecycleAPI(sendUserMessage);
    registerMergeReadyWatchLifecycle(api);

    const start = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus,
        sleep,
        syncStatusBar,
        checkDirtyWorkingTree,
        maxIterations: 1,
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    const onSettled = vi.fn();
    start.promise.finally(onSettled);
    await flushMicrotasks();

    expect(checkDirtyWorkingTree).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: 'followUp' });
    expect(checkDirtyWorkingTree.mock.invocationCallOrder[0]).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(vi.mocked(ctx.waitForIdle)).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(syncStatusBar).toHaveBeenCalledTimes(1);
    expect(getActiveMergeReadyWatch()?.phase).toBe('repair_queued');
    expect(onSettled).not.toHaveBeenCalled();

    await getHandler('agent_end')?.({}, ctx);
    await flushMicrotasks();

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(syncStatusBar).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(30_000, expect.any(AbortSignal));
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Repair queued #42 · ci_failing'),
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Watching #42 · Checks are still running'),
    );
    expect(
      vi
        .mocked(ctx.ui.setStatus!)
        .mock.calls.filter(([key]) => key === MERGE_READY_WATCH_STATUS_KEY)
        .some(([, value]) => typeof value === 'string' && value.includes('next poll')),
    ).toBe(false);

    resolveNext();
    await expect(start.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
    });

    const prompt = vi.mocked(sendUserMessage).mock.calls[0]?.[0];
    expect(prompt).toContain('Use the merge-ready-loop skill');
    expect(prompt).toContain(
      'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair',
    );
    expect(prompt).toContain('Do not assume any specific subagent framework.');
    expect(prompt).toContain('ci_failing');
    expect(prompt).toContain('Do not start another watch loop.');
  });

  it('stops immediately on status_ambiguous without sending repair work', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );

    const result = await runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: { sendUserMessage },
      ctx,
      intervalSeconds: 30,
      signal: new AbortController().signal,
      dependencies: {
        getStatus: createStatusSequence([createStatusAmbiguousStatus()]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: false }),
        maxIterations: 1,
      },
    });

    expect(result).toMatchObject({ kind: 'stopped', reason: 'status_ambiguous' });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual([
      'Stopping merge-ready watch for https://github.com/robhowley/pi-userland/pull/42: Merge readiness is ambiguous',
      'warning',
    ]);
  });

  it('stops before auto-repair when the working tree is dirty', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );

    const result = await runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: { sendUserMessage },
      ctx,
      intervalSeconds: 30,
      signal: new AbortController().signal,
      dependencies: {
        getStatus: createStatusSequence([createCiFailingStatus()]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: true }),
        maxIterations: 1,
      },
    });

    expect(result).toMatchObject({ kind: 'stopped', reason: 'dirty_worktree' });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual([
      'Stopping merge-ready watch for https://github.com/robhowley/pi-userland/pull/42: local git changes are present, so auto-repair is disabled.',
      'warning',
    ]);
  });

  it('stops on a repeated actionable signature only after the post-agent_end refresh', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const status = createCiFailingStatus();
    const getStatus = createStatusSequence([status, status]);
    const { api, getHandler } = createWatchLifecycleAPI(sendUserMessage);
    registerMergeReadyWatchLifecycle(api);

    const start = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus,
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: async () => ({ ok: true, dirty: false }),
        maxIterations: 1,
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    const onSettled = vi.fn();
    start.promise.finally(onSettled);
    await flushMicrotasks();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.waitForIdle)).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify).mock.calls).not.toContainEqual([
      'Stopping merge-ready watch for https://github.com/robhowley/pi-userland/pull/42: the same actionable blocker is still present after one attempt.',
      'warning',
    ]);

    await getHandler('agent_end')?.({}, ctx);

    await expect(start.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'repeated_actionable_signature',
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual([
      'Stopping merge-ready watch for https://github.com/robhowley/pi-userland/pull/42: the same actionable blocker is still present after one attempt.',
      'warning',
    ]);
  });

  it('clears attempted actionable signatures after a repair settles into wait and allows the same signature later', async () => {
    const ctx = createWatchContext();
    const firstAgentEnd = createDeferred<void>();
    const secondAgentEnd = createDeferred<void>();
    let repairTurn = 0;
    const waitForAgentEnd = vi.fn(() => {
      repairTurn += 1;
      return repairTurn === 1 ? firstAgentEnd.promise : secondAgentEnd.promise;
    });
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const checkDirtyWorkingTree = vi.fn(async () => ({ ok: true as const, dirty: false }));
    const result = runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: { sendUserMessage },
      ctx,
      intervalSeconds: 30,
      signal: new AbortController().signal,
      dependencies: {
        getStatus: createStatusSequence([
          createCiFailingStatus(),
          createCiRunningStatus(),
          createCiFailingStatus(),
          createCiRunningStatus(),
        ]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree,
        waitForAgentEnd,
        maxIterations: 2,
      },
      loadConfig: vi.fn(
        async () => ({
          autoCompactRepair: false,
          cacheTTLSeconds: 60,
          enableStatusBarDiagnostics: false,
        }),
      ),
    });
    const onSettled = vi.fn();
    result.finally(onSettled);

    await flushMicrotasks(12);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(checkDirtyWorkingTree).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    firstAgentEnd.resolve();
    await flushMicrotasks(12);

    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(checkDirtyWorkingTree).toHaveBeenCalledTimes(2);
    expect(waitForAgentEnd).toHaveBeenCalledTimes(2);
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify).mock.calls).not.toContainEqual([
      'Stopping merge-ready watch for https://github.com/robhowley/pi-userland/pull/42: the same actionable blocker is still present after one attempt.',
      'warning',
    ]);

    secondAgentEnd.resolve();

    await expect(result).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
      status: createCiRunningStatus(),
    });
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('stops on a repeated URL actionable signature only after the post-agent_end refresh', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const checkDirtyWorkingTree = vi.fn(async () => ({ ok: true as const, dirty: false }));
    const status = createUrlCiFailingStatus();
    const getStatus = createStatusSequence([status, status]);
    const { api, getHandler } = createWatchLifecycleAPI(sendUserMessage);
    registerMergeReadyWatchLifecycle(api);

    const start = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus,
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree,
        maxIterations: 1,
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(checkDirtyWorkingTree).not.toHaveBeenCalled();

    await getHandler('agent_end')?.({}, ctx);

    await expect(start.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'repeated_actionable_signature',
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual([
      `Stopping merge-ready watch for ${RUNTIME_URL_TARGET.url}: the same actionable blocker is still present after one attempt.`,
      'warning',
    ]);
  });

  it('queues one URL-targeted follow-up repair without ambient dirty preflight and refreshes only after agent_end', async () => {
    const ctx = createWatchContext();
    const { sleep, resolveNext } = createControlledAbortableSleep();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const syncStatusBar = vi.fn((options: Parameters<typeof syncMergeReadyStatusBar>[0]) =>
      syncMergeReadyStatusBar(options),
    );
    const checkDirtyWorkingTree = vi.fn(async () => ({ ok: true as const, dirty: false }));
    const { api, getHandler } = createWatchLifecycleAPI(sendUserMessage);
    registerMergeReadyWatchLifecycle(api);

    const start = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 45,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([createUrlCiFailingStatus(), createUrlCiRunningStatus()]),
        sleep,
        syncStatusBar,
        checkDirtyWorkingTree,
        maxIterations: 1,
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();

    expect(syncStatusBar).toHaveBeenCalledTimes(1);
    expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: 'followUp' });
    expect(sleep).not.toHaveBeenCalled();

    await getHandler('agent_end')?.({}, ctx);
    await flushMicrotasks();

    expect(syncStatusBar).toHaveBeenCalledTimes(2);
    expect(checkDirtyWorkingTree).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(45_000, expect.any(AbortSignal));
    expect(vi.mocked(ctx.ui.setStatus)).not.toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      expect.anything(),
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Repair queued #64 · ci_failing'),
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Watching #64 · Checks are still running'),
    );
    expect(
      vi
        .mocked(ctx.ui.setStatus!)
        .mock.calls.filter(([key]) => key === MERGE_READY_WATCH_STATUS_KEY)
        .some(([, value]) => typeof value === 'string' && value.includes('next poll')),
    ).toBe(false);

    resolveNext();
    await expect(start.promise).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
    });

    const prompt = vi.mocked(sendUserMessage).mock.calls[0]?.[0];
    expect(prompt).toContain(`Use the merge-ready-loop skill for ${RUNTIME_URL_TARGET.url}.`);
    expect(prompt).toContain('Do this URL-targeted repair in an isolated git worktree');
    expect(prompt).toContain(
      'If your environment supports isolated worker/session/agent contexts, prefer using one for this bounded repair',
    );
    expect(prompt).toContain('Do not assume any specific subagent framework.');
    expect(prompt).toContain('Do not mutate the ambient checkout.');
    expect(prompt).toContain("Use the snapshot's pr.headRepository and pr.headRefName");
    expect(prompt).toContain(
      'Report the worktree path used, whether the patch was pushed/prepared',
    );
  });

  it('keeps ambient status suspended through URL repair follow-up turns and resumes afterward', async () => {
    const ctx = createWatchContext();
    const sendUserMessage = vi.fn(
      async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
    );
    const sleep = vi.fn((_ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      }

      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    });
    const syncStatusBar = vi.fn((options: Parameters<typeof syncMergeReadyStatusBar>[0]) =>
      syncMergeReadyStatusBar(options),
    );
    const { api, getHandler } = createWatchLifecycleAPI(sendUserMessage);
    registerMergeReadyWatchLifecycle(api);

    syncMergeReadyStatusBar({
      ctx,
      status: createNoPullRequestStatus(),
      now: 1_000,
    });
    vi.mocked(ctx.ui.setStatus!).mockClear();

    const refreshCtx = {
      cwd: ctx.cwd,
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
      },
    };
    const refreshExec = createFakeExec([
      createCurrentBranchProbeCall({
        branch: 'feat/merge-ready',
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createCurrentBranchProbeCall({
        branch: 'feat/merge-ready',
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
      createCurrentBranchProbeCall({
        branch: 'feat/merge-ready',
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
    ]);
    const watchExec = createFakeExec([
      createCurrentBranchProbeCall({
        branch: 'feat/merge-ready',
        timeout: MERGE_READY_STATUS_BAR_TIMEOUT_MS,
      }),
    ]);

    const abortController = new AbortController();
    const start = startMergeReadyWatch({
      api,
      ctx,
      exec: watchExec.exec,
      intervalSeconds: 45,
      signal: abortController.signal,
      url: RUNTIME_URL_TARGET.url,
      dependencies: {
        getStatus: createStatusSequence([createUrlCiFailingStatus(), createUrlCiRunningStatus()]),
        sleep,
        syncStatusBar,
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();

    expect(isMergeReadyStatusBarSuspended()).toBe(true);
    expect(getActiveMergeReadyWatch()?.phase).toBe('repair_queued');
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);
    expect(vi.mocked(ctx.ui.setStatus)).not.toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      '✅ #42 Ready',
    );

    const hiddenWhileRepairQueued = await refreshMergeReadyStatusBar({
      exec: refreshExec.exec,
      ctx: refreshCtx,
      now: 1_000 + MERGE_READY_STATUS_BAR_TTL_MS - 1,
    });

    expect(hiddenWhileRepairQueued).toEqual({ text: '❔ No PR', cached: true });
    expect(refreshCtx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);

    await getHandler('agent_end')?.({}, ctx);
    await flushMicrotasks();

    expect(isMergeReadyStatusBarSuspended()).toBe(true);
    expect(getActiveMergeReadyWatch()?.phase).toBe('watching');
    expect(syncStatusBar).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Watching #64 · Checks are still running'),
    );
    expect(
      vi
        .mocked(ctx.ui.setStatus!)
        .mock.calls.filter(([key]) => key === MERGE_READY_WATCH_STATUS_KEY)
        .some(([, value]) => typeof value === 'string' && value.includes('next poll')),
    ).toBe(false);

    vi.mocked(refreshCtx.ui.setStatus).mockClear();
    const hiddenAfterAgentEnd = await refreshMergeReadyStatusBar({
      exec: refreshExec.exec,
      ctx: refreshCtx,
      now: 2_000,
    });

    expect(hiddenAfterAgentEnd).toEqual({ text: '❔ No PR', cached: true });
    expect(refreshCtx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);

    abortController.abort();
    await expect(start.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    watchExec.assertDone();
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      undefined,
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      '❔ No PR',
    );

    vi.mocked(refreshCtx.ui.setStatus).mockClear();
    const visibleAfterStop = await refreshMergeReadyStatusBar({
      exec: refreshExec.exec,
      ctx: refreshCtx,
      now: 3_000,
    });

    refreshExec.assertDone();
    expect(visibleAfterStop?.text).toBe('❔ No PR');
    expect(refreshCtx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '❔ No PR');
  });

  it('awaits blocking compaction before resuming polling after a successful repair', async () => {
    const compactResult = createDeferred<void>();
    const waitForAgentEnd = createDeferred<void>();
    const ctx: Parameters<typeof runMergeReadyWatchLoop>[0]['ctx'] = {
      ...createWatchContext({ projectTrusted: true }),
      compact: vi.fn(() => compactResult.promise),
    };
    const sleep = vi.fn(async () => undefined);
    const loadConfig = vi.fn(
      async () => ({
        autoCompactRepair: true,
        cacheTTLSeconds: 60,
        enableStatusBarDiagnostics: false,
      }),
    );

    const result = runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: {
        sendUserMessage: vi.fn(
          async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
        ),
      },
      ctx,
      intervalSeconds: 30,
      signal: new AbortController().signal,
      dependencies: {
        getStatus: createStatusSequence([createCiFailingStatus(), createReadyStatus()]),
        sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        waitForAgentEnd: vi.fn(() => waitForAgentEnd.promise),
        maxIterations: 1,
      },
      loadConfig,
    });
    const onSettled = vi.fn();
    result.finally(onSettled);

    await flushMicrotasks(12);
    waitForAgentEnd.resolve();
    await flushMicrotasks(12);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(ctx.compact).toHaveBeenCalledWith({
      customInstructions:
        'Compaction triggered after successful merge-ready repair loop completion',
    });
    expect(loadConfig).toHaveBeenCalledWith('/repo', true);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Compacting after successful repair…'),
    );
    expect(
      vi
        .mocked(ctx.ui.setStatus!)
        .mock.calls.filter(([key]) => key === MERGE_READY_WATCH_STATUS_KEY)
        .some(
          ([, value]) =>
            typeof value === 'string' && value.includes('Watching #42 · Ready to merge'),
        ),
    ).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();

    compactResult.resolve();
    await expect(result).resolves.toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
      status: createReadyStatus(),
    });
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Watching #42 · Ready to merge'),
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('warns on compaction failure and keeps polling', async () => {
    const ctx: Parameters<typeof runMergeReadyWatchLoop>[0]['ctx'] = {
      ...createWatchContext(),
      compact: vi.fn(async () => {
        throw new Error('Compaction exploded');
      }),
    };
    const sleep = vi.fn(async () => undefined);

    const result = await runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: {
        sendUserMessage: vi.fn(
          async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
        ),
      },
      ctx,
      intervalSeconds: 30,
      signal: new AbortController().signal,
      dependencies: {
        getStatus: createStatusSequence([createCiFailingStatus(), createCiRunningStatus()]),
        sleep,
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        waitForAgentEnd: vi.fn(async () => undefined),
        maxIterations: 1,
      },
      loadConfig: vi.fn(
        async () => ({
          autoCompactRepair: true,
          cacheTTLSeconds: 60,
          enableStatusBarDiagnostics: false,
        }),
      ),
    });

    expect(result).toMatchObject({
      kind: 'stopped',
      reason: 'max_iterations',
      status: createCiRunningStatus(),
    });
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.ui.notify).mock.calls).toContainEqual([
      'Compaction failed after repair: Compaction exploded',
      'warning',
    ]);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      expect.stringContaining('Watching #42 · Checks are still running'),
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('treats stop-during-compaction as watch abort when compaction rejects on abort', async () => {
    const abortController = new AbortController();
    const ctx: Parameters<typeof runMergeReadyWatchLoop>[0]['ctx'] = {
      ...createWatchContext(),
      compact: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            abortController.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    };
    const result = runMergeReadyWatchLoop({
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      api: {
        sendUserMessage: vi.fn(
          async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
        ),
      },
      ctx,
      intervalSeconds: 30,
      signal: abortController.signal,
      dependencies: {
        getStatus: createStatusSequence([createCiFailingStatus(), createReadyStatus()]),
        sleep: vi.fn(async () => undefined),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        waitForAgentEnd: vi.fn(async () => undefined),
      },
      loadConfig: vi.fn(
        async () => ({
          autoCompactRepair: true,
          cacheTTLSeconds: 60,
          enableStatusBarDiagnostics: false,
        }),
      ),
    });

    await flushMicrotasks(12);
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    abortController.abort();

    await expect(result).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    expect(vi.mocked(ctx.ui.notify).mock.calls).not.toContainEqual([
      'Compaction failed after repair: Aborted',
      'warning',
    ]);
  });

  it('creates stable blocker signatures across generatedAt and detail ordering changes', () => {
    const first = createReadyStatus({
      openItems: [
        {
          id: 'ci_failing',
          summary: 'Required checks are failing',
          details: [
            { label: 'ci / unit', status: 'failing' },
            { label: 'ci / lint', status: 'failing' },
          ],
        },
      ],
      summary: 'Required checks are failing',
    });
    const second = createReadyStatus({
      generatedAt: '2026-06-05T01:00:00.000Z',
      openItems: [
        {
          id: 'ci_failing',
          summary: 'Required checks are failing',
          details: [
            { label: 'ci / lint', status: 'failing' },
            { label: 'ci / unit', status: 'failing' },
          ],
        },
      ],
      summary: 'Required checks are failing',
    });

    expect(createMergeReadyWatchBlockerSignature(first, first.openItems)).toBe(
      createMergeReadyWatchBlockerSignature(second, second.openItems),
    );
  });
});

describe('merge-ready watch teardown restore', () => {
  afterEach(() => {
    vi.doUnmock('../../extensions/merge-ready/status-bar.js');
    vi.resetModules();
  });

  it('restores the ambient footer via refresh after suspension is released', async () => {
    type MockStatusBarCtx = {
      cwd: string;
      ui?: {
        setStatus?: (key: string, status?: string) => void;
      };
    };

    let suspended = false;
    const refreshCalls: Array<{ suspended: boolean; cwd: string }> = [];
    const refreshMergeReadyStatusBar = vi.fn(async (options: { ctx: MockStatusBarCtx }) => {
      refreshCalls.push({ suspended, cwd: options.ctx.cwd });
      options.ctx.ui?.setStatus?.(MERGE_READY_STATUS_BAR_KEY, '✅ #42 Ready');
      return { text: '✅ #42 Ready', cached: false };
    });
    const suspendMergeReadyStatusBar = vi.fn((ctx: MockStatusBarCtx) => {
      suspended = true;
      ctx.ui?.setStatus?.(MERGE_READY_STATUS_BAR_KEY, undefined);
      return () => {
        suspended = false;
      };
    });

    vi.resetModules();
    vi.doMock('../../extensions/merge-ready/status-bar.js', () => ({
      isMergeReadyStatusBarSuspended: () => suspended,
      refreshMergeReadyStatusBar,
      suspendMergeReadyStatusBar,
      syncMergeReadyStatusBar: vi.fn(),
    }));

    const watchModule = await import('../../extensions/merge-ready/watch.js');
    const ctx = createWatchContext();
    const start = watchModule.startMergeReadyWatch({
      api: {
        sendUserMessage: vi.fn(
          async (_content: string, _options?: { deliverAs?: 'steer' | 'followUp' }) => undefined,
        ),
      },
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
      dependencies: {
        getStatus: createStatusSequence([createReadyStatus()]),
        sleep: createAbortableSleep(),
        syncStatusBar: vi.fn(),
        checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
      },
    });

    expect(start.ok).toBe(true);
    if (!start.ok) {
      return;
    }

    await flushMicrotasks();
    expect(suspended).toBe(true);

    expect(watchModule.stopActiveMergeReadyWatch()).toEqual({
      stopped: true,
      targetLabel: 'current branch PR',
      phase: 'watching',
    });
    await expect(start.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    await watchModule.resetMergeReadyWatchState();

    expect(suspendMergeReadyStatusBar).toHaveBeenCalledTimes(1);
    expect(refreshMergeReadyStatusBar).toHaveBeenCalledTimes(1);
    expect(refreshCalls).toEqual([{ suspended: false, cwd: '/repo' }]);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      undefined,
    );
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_STATUS_BAR_KEY,
      '✅ #42 Ready',
    );
  });
});
