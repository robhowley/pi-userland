import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMergeReadyStatus,
  isMergeReadyStatusBarSuspended,
  MERGE_READY_STATUS_BAR_KEY,
  MERGE_READY_STATUS_BAR_TTL_MS,
  MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS,
  MERGE_READY_WATCH_MAX_INTERVAL_SECONDS,
  MERGE_READY_WATCH_MIN_INTERVAL_SECONDS,
  MERGE_READY_WATCH_STATUS_KEY,
  classifyMergeReadyWatchStatus,
  createMergeReadyWatchBlockerSignature,
  createMergeReadyWatchRepairPrompt,
  getActiveMergeReadyWatch,
  parseMergeReadyWatchIntervalSeconds,
  refreshMergeReadyStatusBar,
  registerMergeReadyWatchLifecycle,
  resetMergeReadyStatusBarCache,
  resetMergeReadyWatchState,
  runMergeReadyWatchLoop,
  sleepWithAbort,
  startMergeReadyWatch,
  syncMergeReadyStatusBar,
  type MergeReadyCommandContext,
  type MergeReadyOpenItem,
  type MergeReadyPullRequest,
  type MergeReadySignals,
  type MergeReadyStatus,
  type MergeReadyTarget,
} from '../../extensions/merge-ready/index.js';
import { CURRENT_BRANCH_TARGET } from './test-fixtures.js';

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

const RUNTIME_URL_TARGET = {
  mode: 'url',
  url: 'https://github.com/shopify/pi/pull/64',
  owner: 'shopify',
  repo: 'pi',
  prNumber: 64,
} as const;

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

function buildRuntimeUrlOpenPr(overrides: Partial<NonNullable<MergeReadyStatus['pr']>> = {}) {
  return buildRuntimeOpenPr({
    number: 64,
    title: 'Support explicit PR URL targets',
    url: RUNTIME_URL_TARGET.url,
    headRefName: 'feat/explicit-pr-url',
    headRepository: {
      owner: 'shopify',
      repo: 'pi',
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

function createUrlCiFailingStatus(): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: RUNTIME_URL_TARGET,
    pr: buildRuntimeUrlOpenPr(),
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

function createUrlCiRunningStatus(): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: RUNTIME_URL_TARGET,
    pr: buildRuntimeUrlOpenPr(),
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

function createUrlReadyStatus(): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    target: RUNTIME_URL_TARGET,
    pr: buildRuntimeUrlOpenPr(),
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

function createWatchContext(): MergeReadyCommandContext {
  return {
    cwd: '/repo',
    isIdle: vi.fn(() => true),
    waitForIdle: vi.fn(async () => undefined),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

function createStatusSequence(statuses: MergeReadyStatus[]) {
  let index = 0;
  return vi.fn(async (_options?: unknown) => statuses[Math.min(index++, statuses.length - 1)]!);
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

  it('allows only one active foreground watcher at a time', async () => {
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

    const firstStart = startMergeReadyWatch({
      api: { sendUserMessage },
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
      api: { sendUserMessage },
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      intervalSeconds: 30,
    });

    expect(firstStart).toMatchObject({ ok: true, level: 'info' });
    expect(secondStart).toEqual({
      ok: false,
      level: 'warning',
      message:
        'Merge-ready watch is already active for current branch PR. Cancel the foreground watch before starting another.',
    });

    await resetMergeReadyWatchState();
    if (firstStart.ok) {
      await firstStart.promise;
    }
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

    expect(result).toEqual({ kind: 'stopped', reason: 'max_iterations' });
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
    const pollDelay = createDeferred<void>();
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => pollDelay.promise);
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

    pollDelay.resolve();
    await expect(start.promise).resolves.toEqual({ kind: 'stopped', reason: 'max_iterations' });

    const prompt = vi.mocked(sendUserMessage).mock.calls[0]?.[0];
    expect(prompt).toContain('Use the merge-ready-loop skill');
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
    const pollDelay = createDeferred<void>();
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal) => pollDelay.promise);
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

    pollDelay.resolve();
    await expect(start.promise).resolves.toEqual({ kind: 'stopped', reason: 'max_iterations' });

    const prompt = vi.mocked(sendUserMessage).mock.calls[0]?.[0];
    expect(prompt).toContain(`Use the merge-ready-loop skill for ${RUNTIME_URL_TARGET.url}.`);
    expect(prompt).toContain('Do this URL-targeted repair in an isolated git worktree');
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

    const abortController = new AbortController();
    const start = startMergeReadyWatch({
      api,
      ctx,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
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
      '✅ Ready',
    );

    const hiddenWhileRepairQueued = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
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
      exec: vi.fn(),
      ctx: refreshCtx,
      now: 2_000,
    });

    expect(hiddenAfterAgentEnd).toEqual({ text: '❔ No PR', cached: true });
    expect(refreshCtx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, undefined);

    abortController.abort();
    await expect(start.promise).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    expect(isMergeReadyStatusBarSuspended()).toBe(false);
    expect(vi.mocked(ctx.ui.setStatus)).toHaveBeenCalledWith(
      MERGE_READY_WATCH_STATUS_KEY,
      undefined,
    );

    vi.mocked(refreshCtx.ui.setStatus).mockClear();
    const visibleAfterStop = await refreshMergeReadyStatusBar({
      exec: vi.fn(),
      ctx: refreshCtx,
      now: 3_000,
    });

    expect(visibleAfterStop).toEqual({ text: '❔ No PR', cached: true });
    expect(refreshCtx.ui.setStatus).toHaveBeenCalledWith(MERGE_READY_STATUS_BAR_KEY, '❔ No PR');
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
