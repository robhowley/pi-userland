import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMergeReadyAttention,
  createCmuxProcessRunner,
  createMergeReadyCmuxAction,
  createMergeReadyCmuxPublisher,
  type MergeReadyAttentionBucket,
} from '../../extensions/merge-ready/cmux-status.js';
import { createMergeReadyStatus } from '../../extensions/merge-ready/status.js';
import type {
  MergeReadyOpenItemId,
  MergeReadyStatus,
  PullRequestLifecycle,
} from '../../extensions/merge-ready/types.js';

const sandboxes: Array<() => void> = [];
type CmuxRun = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

function createRunMock(implementation: CmuxRun = async () => undefined) {
  return vi.fn(implementation);
}

function createPullRequestStatus(
  options: {
    number?: number;
    url?: string;
  } = {},
) {
  const number = options.number ?? 170;
  return createMergeReadyStatus({
    generatedAt: '2026-08-17T00:00:00.000Z',
    pr: {
      lifecycle: 'open',
      number,
      title: 'Link the cmux status pill',
      url: options.url ?? `https://github.com/robhowley/pi-userland/pull/${String(number)}`,
      headRefName: 'feat/linked-cmux-pill',
      baseRefName: 'main',
    },
    signals: {
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createStatusWithItems(
  ids: MergeReadyOpenItemId[],
  options: {
    number?: number;
    url?: string;
    lifecycle?: PullRequestLifecycle;
  } = {},
): MergeReadyStatus {
  const status = createPullRequestStatus({
    ...(options.number === undefined ? {} : { number: options.number }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
  return createMergeReadyStatus({
    generatedAt: status.generatedAt,
    pr: { ...status.pr!, lifecycle: options.lifecycle ?? 'open' },
    signals: status.signals,
    openItems: ids.map((id) => ({ id, summary: id })),
  });
}

const ATTENTION_ITEM: Record<
  Exclude<MergeReadyAttentionBucket, 'unknown' | 'ready'>,
  MergeReadyOpenItemId
> = {
  waiting: 'ci_running',
  action_required: 'ci_failing',
  quiet_blocked: 'draft',
};

function createAttentionStatus(
  bucket: Exclude<MergeReadyAttentionBucket, 'unknown'>,
  number = 170,
) {
  return createStatusWithItems(bucket === 'ready' ? [] : [ATTENTION_ITEM[bucket]], { number });
}

function notificationCalls(run: ReturnType<typeof createRunMock>) {
  return run.mock.calls.filter(([, args]) => args[2] === 'notify');
}

function createSandbox() {
  const originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const root = mkdtempSync(join(tmpdir(), 'pi-merge-ready-cmux-'));
  const cwd = join(root, 'repo');
  const agentDir = join(root, 'agent');
  mkdirSync(cwd, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = agentDir;

  const writeJson = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), 'utf8');
  };
  const cleanup = () => {
    if (originalAgentDir === undefined) {
      delete process.env['PI_CODING_AGENT_DIR'];
    } else {
      process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    }
    rmSync(root, { recursive: true, force: true });
  };
  sandboxes.push(cleanup);

  return {
    root,
    cwd,
    writeGlobal(value: unknown) {
      writeJson(join(agentDir, 'settings.json'), value);
    },
    writeProject(value: unknown) {
      writeJson(join(cwd, '.pi', 'settings.json'), value);
    },
  };
}

function eligibleEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CMUX_WORKSPACE_ID: ' workspace:1 ',
    CMUX_SOCKET_PATH: ' /tmp/cmux.sock ',
    ...overrides,
  };
}

function createPublisher(
  options: {
    env?: NodeJS.ProcessEnv;
    mode?: string;
    projectTrusted?: boolean;
    run?: CmuxRun;
  } = {},
) {
  const sandbox = createSandbox();
  return createMergeReadyCmuxPublisher({
    cwd: sandbox.cwd,
    mode: options.mode ?? 'tui',
    projectTrusted: options.projectTrusted ?? false,
    env: options.env ?? eligibleEnv(),
    run: options.run ?? createRunMock(),
  });
}

afterEach(() => {
  vi.useRealTimers();
  while (sandboxes.length > 0) {
    sandboxes.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('merge-ready cmux status', () => {
  it('clears only confirmed no_pull_request and preserves ambiguous Unknown rendering', () => {
    const noPullRequest = createMergeReadyStatus({
      generatedAt: '2026-08-17T00:00:00.000Z',
      pr: null,
    });
    const ambiguous = createMergeReadyStatus({
      generatedAt: '2026-08-17T00:00:00.000Z',
      pr: null,
      hasPr: true,
      openItems: [{ id: 'status_ambiguous', summary: 'Unknown' }],
    });

    expect(createMergeReadyCmuxAction(noPullRequest, '❔ No PR')).toEqual({ kind: 'clear' });
    expect(createMergeReadyCmuxAction(ambiguous, '❔ Unknown')).toEqual({
      kind: 'set',
      value: '❔ Unknown',
    });
  });

  it('links only the PR token and sends Markdown format for PR-backed sets', async () => {
    const status = createPullRequestStatus();
    const action = createMergeReadyCmuxAction(status, '✅ #170 Ready');

    expect(action).toEqual({
      kind: 'set',
      value: '✅ [PR #170](https://github.com/robhowley/pi-userland/pull/170) Ready',
      format: 'markdown',
    });

    const run = createRunMock();
    const publisher = createPublisher({ run });
    publisher!.enqueue(action);
    await publisher!.shutdown();

    expect(run.mock.calls[0]?.[0]).toBe('cmux');
    expect(run.mock.calls[0]?.[1]).toEqual([
      '--socket',
      '/tmp/cmux.sock',
      'set-status',
      'pi-merge-ready',
      '✅ [PR #170](https://github.com/robhowley/pi-userland/pull/170) Ready',
      '--format',
      'markdown',
      '--workspace',
      'workspace:1',
    ]);
    expect(run.mock.calls[0]?.[1]).not.toContain('--url');
  });

  it.each([
    { name: 'eligible TUI', mode: 'tui', env: eligibleEnv(), active: true },
    { name: 'print mode', mode: 'print', env: eligibleEnv(), active: false },
    {
      name: 'blank workspace',
      mode: 'tui',
      env: eligibleEnv({ CMUX_WORKSPACE_ID: '  ' }),
      active: false,
    },
    {
      name: 'blank socket',
      mode: 'tui',
      env: eligibleEnv({ CMUX_SOCKET_PATH: '\t' }),
      active: false,
    },
    { name: 'nonblank CI', mode: 'tui', env: eligibleEnv({ CI: '0' }), active: false },
    { name: 'nested tmux', mode: 'tui', env: eligibleEnv({ TMUX: '/tmp/tmux' }), active: true },
  ])('$name eligibility is $active', ({ mode, env, active }) => {
    const publisher = createPublisher({ mode, env });
    expect(publisher !== null).toBe(active);
  });

  it('makes no transport call when disabled, including attempted shutdown', async () => {
    const sandbox = createSandbox();
    sandbox.writeGlobal({ 'pi-merge-ready': { cmux: { enabled: false } } });
    const run = createRunMock();
    const publisher = createMergeReadyCmuxPublisher({
      cwd: sandbox.cwd,
      mode: 'tui',
      projectTrusted: false,
      env: eligibleEnv(),
      run,
    });

    publisher?.enqueue({ kind: 'set', value: 'Ready' });
    await publisher?.shutdown();

    expect(publisher).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'defaults enabled',
      global: {},
      project: {},
      trusted: false,
      active: true,
    },
    {
      name: 'global false',
      global: { 'pi-merge-ready': { cmux: { enabled: false } } },
      project: {},
      trusted: false,
      active: false,
    },
    {
      name: 'trusted project overrides global',
      global: { 'pi-merge-ready': { cmux: { enabled: false } } },
      project: { 'pi-merge-ready': { cmux: { enabled: true } } },
      trusted: true,
      active: true,
    },
    {
      name: 'untrusted project is ignored',
      global: { 'pi-merge-ready': { cmux: { enabled: true } } },
      project: { 'pi-merge-ready': { cmux: { enabled: false } } },
      trusted: false,
      active: true,
    },
    {
      name: 'malformed project falls through',
      global: { 'pi-merge-ready': { cmux: { enabled: false } } },
      project: { 'pi-merge-ready': { cmux: { enabled: 'yes' } } },
      trusted: true,
      active: false,
    },
  ])('$name config layering', ({ global, project, trusted, active }) => {
    const sandbox = createSandbox();
    sandbox.writeGlobal(global);
    sandbox.writeProject(project);

    const publisher = createMergeReadyCmuxPublisher({
      cwd: sandbox.cwd,
      mode: 'tui',
      projectTrusted: trusted,
      env: eligibleEnv(),
      run: createRunMock(),
    });

    expect(publisher !== null).toBe(active);
  });

  it('uses PATH cmux and exact set/clear argv with trimmed targets', async () => {
    const run = createRunMock();
    const publisher = createPublisher({ run });
    expect(publisher).not.toBeNull();

    publisher!.enqueue({ kind: 'set', value: '✅ #42 Ready' });
    await publisher!.shutdown();

    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [
        'cmux',
        [
          '--socket',
          '/tmp/cmux.sock',
          'set-status',
          'pi-merge-ready',
          '✅ #42 Ready',
          '--workspace',
          'workspace:1',
        ],
      ],
      [
        'cmux',
        [
          '--socket',
          '/tmp/cmux.sock',
          'clear-status',
          'pi-merge-ready',
          '--workspace',
          'workspace:1',
        ],
      ],
    ]);
  });

  it.each([
    {
      name: 'malformed URL',
      url: 'https://github.com/robhowley/pi-userland/pull/not-a-number',
      renderedStatus: '✅ #170 Ready',
    },
    {
      name: 'mismatched URL number',
      url: 'https://github.com/robhowley/pi-userland/pull/171',
      renderedStatus: '✅ #170 Ready',
    },
    {
      name: 'unencodable URL',
      url: 'https://github.com/robhowley/repo\uD800/pull/170',
      renderedStatus: '✅ #170 Ready',
    },
    {
      name: 'missing PR token',
      url: 'https://github.com/robhowley/pi-userland/pull/170',
      renderedStatus: '✅ 170 Ready',
    },
  ])('$name keeps the plain action', ({ url, renderedStatus }) => {
    expect(createMergeReadyCmuxAction(createPullRequestStatus({ url }), renderedStatus)).toEqual({
      kind: 'set',
      value: renderedStatus,
    });
  });

  it('percent-encodes owner and repository segments before linking', () => {
    const status = createPullRequestStatus({
      url: 'https://github.com/owner&team/repo+name/pull/170',
    });

    expect(createMergeReadyCmuxAction(status, '✅ #170 Ready')).toEqual({
      kind: 'set',
      value: '✅ [PR #170](https://github.com/owner%26team/repo%2Bname/pull/170) Ready',
      format: 'markdown',
    });
  });

  it('links repository names containing underscores', () => {
    const status = createPullRequestStatus({
      url: 'https://github.com/owner/repo_name/pull/170',
    });

    expect(createMergeReadyCmuxAction(status, '✅ #170 Ready')).toEqual({
      kind: 'set',
      value: '✅ [PR #170](https://github.com/owner/repo_name/pull/170) Ready',
      format: 'markdown',
    });
  });

  it('treats plain and Markdown set formats as different requests', async () => {
    const run = createRunMock();
    const publisher = createPublisher({ run });

    publisher!.enqueue({ kind: 'set', value: '✅ #170 Ready' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    publisher!.enqueue({
      kind: 'set',
      value: '✅ #170 Ready',
      format: 'markdown',
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await publisher!.shutdown();

    expect(run.mock.calls[0]?.[1]).toContain('✅ #170 Ready');
    expect(run.mock.calls[0]?.[1]).not.toContain('--format');
  });

  it('prefers an executable bundled cmux CLI', async () => {
    const sandbox = createSandbox();
    const bundled = join(sandbox.root, 'cmux-bundled');
    writeFileSync(bundled, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(bundled, 0o700);
    const run = createRunMock();
    const publisher = createMergeReadyCmuxPublisher({
      cwd: sandbox.cwd,
      mode: 'tui',
      projectTrusted: false,
      env: eligibleEnv({ CMUX_BUNDLED_CLI_PATH: bundled }),
      run,
    });

    publisher!.enqueue({ kind: 'clear' });
    await publisher!.shutdown();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every(([command]) => command === bundled)).toBe(true);
  });

  it('falls back to PATH when the bundled path is not executable', async () => {
    const run = createRunMock();
    const publisher = createPublisher({
      env: eligibleEnv({ CMUX_BUNDLED_CLI_PATH: '/missing/cmux' }),
      run,
    });

    publisher!.enqueue({ kind: 'clear' });
    await publisher!.shutdown();

    expect(run.mock.calls.every(([command]) => command === 'cmux')).toBe(true);
  });

  it('swallows asynchronous and synchronous transport failures', async () => {
    const asyncFailure = createPublisher({
      run: vi.fn(async () => {
        throw new Error('cmux unavailable');
      }),
    });
    const syncFailure = createPublisher({
      run: vi.fn(() => {
        throw new Error('cmux unavailable');
      }),
    });

    asyncFailure!.enqueue({ kind: 'set', value: '❔ Unknown' });
    syncFailure!.enqueue({ kind: 'set', value: '❔ Unknown' });

    await expect(asyncFailure!.shutdown()).resolves.toBeUndefined();
    await expect(syncFailure!.shutdown()).resolves.toBeUndefined();
  });

  it('force-kills and settles a child at the fixed deadline', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      once: EventEmitter['once'];
    };
    child.kill = vi.fn(() => true);
    const spawnProcess = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: { env: NodeJS.ProcessEnv; shell: false; stdio: 'ignore' },
      ) => child,
    );
    const runner = createCmuxProcessRunner({
      timeoutMs: 10,
      spawn: spawnProcess as never,
    });
    const env = { PATH: '/bin' };

    const result = runner('/bundled/cmux', ['--socket', '/tmp/cmux.sock'], env);
    await vi.advanceTimersByTimeAsync(9);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnProcess).toHaveBeenCalledWith('/bundled/cmux', ['--socket', '/tmp/cmux.sock'], {
      env,
      shell: false,
      stdio: 'ignore',
    });
  });

  it('settles silently when spawning throws or the child exits nonzero', async () => {
    const spawnError = createCmuxProcessRunner({
      spawn: vi.fn(() => {
        throw new Error('missing executable');
      }) as never,
    });
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      once: EventEmitter['once'];
    };
    child.kill = vi.fn(() => true);
    const nonzeroExit = createCmuxProcessRunner({ spawn: vi.fn(() => child) as never });

    await expect(spawnError('cmux', [], {})).resolves.toBeUndefined();
    const exited = nonzeroExit('cmux', [], {});
    child.emit('close', 1);
    await expect(exited).resolves.toBeUndefined();
  });

  it('dedupes the last requested action even when transport fails', async () => {
    const run = createRunMock(async () => {
      throw new Error('failed');
    });
    const publisher = createPublisher({ run });

    publisher!.enqueue({ kind: 'set', value: 'A' });
    publisher!.enqueue({ kind: 'set', value: 'A' });
    await publisher!.shutdown();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1]).toContain('A');
    expect(run.mock.calls[1]?.[1]).toContain('clear-status');
  });

  it('keeps one active operation and only the latest pending action', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const values: string[] = [];
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const operation = args[2];
      values.push(operation === 'set-status' ? args[4]! : 'clear');
      if (values.length === 1) {
        await first;
      }
    });
    const publisher = createPublisher({ run });

    publisher!.enqueue({ kind: 'set', value: 'A' });
    await vi.waitFor(() => expect(values).toEqual(['A']));
    publisher!.enqueue({ kind: 'set', value: 'B' });
    publisher!.enqueue({ kind: 'set', value: 'C' });
    releaseFirst();
    await vi.waitFor(() => expect(values).toEqual(['A', 'C']));
    await publisher!.shutdown();

    expect(values).toEqual(['A', 'C', 'clear']);
  });

  it('closes intake, drops pending sets, waits for active work, then clears last', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const values: string[] = [];
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      values.push(args[2] === 'set-status' ? args[4]! : 'clear');
      if (values.length === 1) {
        await first;
      }
    });
    const publisher = createPublisher({ run });

    publisher!.enqueue({ kind: 'set', value: 'active' });
    await vi.waitFor(() => expect(values).toEqual(['active']));
    publisher!.enqueue({ kind: 'set', value: 'pending' });
    const shutdown = publisher!.shutdown();
    publisher!.enqueue({ kind: 'set', value: 'late' });
    releaseFirst();
    await shutdown;

    expect(values).toEqual(['active', 'clear']);
  });

  describe('attention notifications', () => {
    it.each([
      ['no_pull_request', 'unknown'],
      ['status_ambiguous', 'unknown'],
      ['merge_conflicts', 'action_required'],
      ['branch_out_of_date', 'action_required'],
      ['merge_blocked', 'action_required'],
      ['draft', 'quiet_blocked'],
      ['ci_failing', 'action_required'],
      ['changes_requested', 'action_required'],
      ['unresolved_conversations', 'quiet_blocked'],
      ['ci_running', 'waiting'],
      ['review_pending', 'waiting'],
    ] satisfies Array<[MergeReadyOpenItemId, MergeReadyAttentionBucket]>)(
      'maps %s to %s',
      (item, expected) => {
        expect(classifyMergeReadyAttention(createStatusWithItems([item])).bucket).toBe(expected);
      },
    );

    it('maps a valid open PR without open items to ready', () => {
      expect(classifyMergeReadyAttention(createStatusWithItems([])).bucket).toBe('ready');
    });

    it.each([
      ['no PR', createMergeReadyStatus({ generatedAt: '2026-08-17T00:00:00.000Z', pr: null })],
      [
        'malformed PR URL',
        createStatusWithItems([], { url: 'https://github.com/owner/repo/pull/nope' }),
      ],
      [
        'mismatched PR number',
        createStatusWithItems([], { url: 'https://github.com/owner/repo/pull/171' }),
      ],
      ['closed PR', createStatusWithItems([], { lifecycle: 'closed' })],
      ['merged PR', createStatusWithItems([], { lifecycle: 'merged' })],
    ])('maps %s to unknown', (_name, status) => {
      expect(classifyMergeReadyAttention(status).bucket).toBe('unknown');
    });

    it.each([
      {
        items: ['status_ambiguous', 'merge_conflicts', 'draft', 'ci_running'],
        bucket: 'unknown',
        reason: undefined,
      },
      {
        items: ['changes_requested', 'ci_failing', 'merge_blocked', 'branch_out_of_date'],
        bucket: 'action_required',
        reason: 'branch_out_of_date',
      },
      {
        items: ['draft', 'unresolved_conversations', 'ci_running'],
        bucket: 'quiet_blocked',
        reason: null,
      },
      { items: ['review_pending', 'ci_running'], bucket: 'waiting', reason: null },
    ] as const)('applies mixed precedence for $items', ({ items, bucket, reason }) => {
      const attention = classifyMergeReadyAttention(
        createStatusWithItems([...items] as MergeReadyOpenItemId[]),
      );
      expect(attention.bucket).toBe(bucket);
      expect(attention.bucket === 'unknown' ? undefined : attention.reason).toBe(reason);
    });

    it.each([
      [
        [
          'merge_conflicts',
          'branch_out_of_date',
          'merge_blocked',
          'ci_failing',
          'changes_requested',
        ],
        'merge_conflicts',
      ],
      [
        ['branch_out_of_date', 'merge_blocked', 'ci_failing', 'changes_requested'],
        'branch_out_of_date',
      ],
      [['merge_blocked', 'ci_failing', 'changes_requested'], 'merge_blocked'],
      [['ci_failing', 'changes_requested'], 'ci_failing'],
      [['changes_requested'], 'changes_requested'],
    ] satisfies Array<[MergeReadyOpenItemId[], MergeReadyOpenItemId]>)(
      'selects action reason %s from %j',
      (items, reason) => {
        const attention = classifyMergeReadyAttention(createStatusWithItems(items));
        expect(attention.bucket === 'unknown' ? null : attention.reason).toBe(reason);
      },
    );

    it('implements the complete 5x5 transition matrix', async () => {
      const buckets: MergeReadyAttentionBucket[] = [
        'unknown',
        'ready',
        'waiting',
        'action_required',
        'quiet_blocked',
      ];
      const notifyingEdges = new Set([
        'ready->action_required',
        'waiting->ready',
        'waiting->action_required',
        'action_required->ready',
        'quiet_blocked->ready',
      ]);

      for (const from of buckets) {
        for (const to of buckets) {
          const run = createRunMock();
          const publisher = createPublisher({ run })!;
          if (from === 'unknown') {
            publisher.observeUnknown();
          } else {
            publisher.observeAttention(createAttentionStatus(from));
          }
          if (to === 'unknown') {
            publisher.observeUnknown();
          } else {
            publisher.observeAttention(createAttentionStatus(to));
          }
          await publisher.shutdown();

          expect(notificationCalls(run).length, `${from}->${to}`).toBe(
            notifyingEdges.has(`${from}->${to}`) ? 1 : 0,
          );
        }
      }
    });

    it('uses exact title, subtitle, body, and argv for every payload', async () => {
      const cases: Array<{ item: MergeReadyOpenItemId; body: string }> = [
        { item: 'merge_conflicts', body: '❌ Merge conflicts need attention' },
        { item: 'branch_out_of_date', body: '🔄 Branch is out of date' },
        { item: 'merge_blocked', body: '❌ GitHub reports merge is blocked' },
        { item: 'ci_failing', body: '❌ Required checks are failing' },
        { item: 'changes_requested', body: '❌ Changes requested by reviewers' },
      ];

      for (const { item, body } of cases) {
        const run = createRunMock();
        const publisher = createPublisher({ run })!;
        publisher.observeAttention(createAttentionStatus('ready'));
        publisher.observeAttention(createStatusWithItems([item]));
        await publisher.shutdown();
        expect(notificationCalls(run)[0]?.[1]).toEqual([
          '--socket',
          '/tmp/cmux.sock',
          'notify',
          '--title',
          'Merge Ready',
          '--subtitle',
          'robhowley/pi-userland PR #170',
          '--body',
          `robhowley/pi-userland PR #170 · ${body}`,
          '--workspace',
          'workspace:1',
        ]);
      }

      const run = createRunMock();
      const publisher = createPublisher({ run })!;
      publisher.observeAttention(createAttentionStatus('action_required'));
      publisher.observeAttention(createAttentionStatus('ready'));
      await publisher.shutdown();
      expect(notificationCalls(run)[0]?.[1]).toEqual([
        '--socket',
        '/tmp/cmux.sock',
        'notify',
        '--title',
        'Merge Ready',
        '--subtitle',
        'robhowley/pi-userland PR #170',
        '--body',
        'robhowley/pi-userland PR #170 · ✅ Ready to merge',
        '--workspace',
        'workspace:1',
      ]);
    });

    it('treats first observations and PR identity changes as baselines', async () => {
      const run = createRunMock();
      const publisher = createPublisher({ run })!;

      publisher.observeAttention(createAttentionStatus('action_required'));
      publisher.observeAttention(createAttentionStatus('ready', 171));
      publisher.observeAttention(createAttentionStatus('action_required', 171));
      await vi.waitFor(() => expect(notificationCalls(run)).toHaveLength(1));
      publisher.observeAttention(createAttentionStatus('ready', 171));
      await vi.waitFor(() => expect(notificationCalls(run)).toHaveLength(2));
      await publisher.shutdown();

      expect(notificationCalls(run)).toHaveLength(2);
      expect(notificationCalls(run).map(([, args]) => args[8])).toEqual([
        'robhowley/pi-userland PR #171 · ❌ Required checks are failing',
        'robhowley/pi-userland PR #171 · ✅ Ready to merge',
      ]);
    });

    it('keeps same-bucket details, comments, and blocker churn silent', async () => {
      const run = createRunMock();
      const publisher = createPublisher({ run })!;
      const failing = createStatusWithItems(['ci_failing']);
      const changedDetails = {
        ...failing,
        openItems: [
          {
            id: 'ci_failing' as const,
            summary: 'Two failures',
            details: [
              { label: 'new check', status: 'failing' as const, url: 'https://example.test' },
            ],
          },
        ],
      };

      publisher.observeAttention(failing);
      publisher.observeAttention(changedDetails);
      publisher.observeAttention(createStatusWithItems(['changes_requested']));
      publisher.observeAttention(createStatusWithItems(['merge_conflicts']));
      publisher.observeAttention(createStatusWithItems(['draft']));
      publisher.observeAttention(createStatusWithItems(['unresolved_conversations']));
      await publisher.shutdown();

      expect(notificationCalls(run)).toHaveLength(0);
    });

    it('stores the baseline before failed transport and does not retry unchanged observations', async () => {
      let notificationAttempts = 0;
      const run = createRunMock(async (_command, args) => {
        if (args[2] === 'notify') {
          notificationAttempts += 1;
          throw new Error('notification failed');
        }
      });
      const publisher = createPublisher({ run })!;

      publisher.observeAttention(createAttentionStatus('waiting'));
      publisher.observeAttention(createAttentionStatus('action_required'));
      await vi.waitFor(() => expect(notificationAttempts).toBe(1));
      publisher.observeAttention(createAttentionStatus('action_required'));
      publisher.enqueue({ kind: 'set', value: 'pill survives' });
      await publisher.shutdown();

      expect(notificationAttempts).toBe(1);
      expect(run.mock.calls.some(([, args]) => args[2] === 'set-status')).toBe(true);
      expect(run.mock.calls.at(-1)?.[1][2]).toBe('clear-status');
    });

    it('serializes every notification across repeated cycles', async () => {
      let releaseFirst!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const bodies: string[] = [];
      const run = createRunMock(async (_command, args) => {
        if (args[2] !== 'notify') {
          return;
        }
        bodies.push(args[8]!);
        if (bodies.length === 1) {
          await first;
        }
      });
      const publisher = createPublisher({ run })!;

      publisher.observeAttention(createAttentionStatus('waiting'));
      publisher.observeAttention(createAttentionStatus('ready'));
      await vi.waitFor(() =>
        expect(bodies).toEqual(['robhowley/pi-userland PR #170 · ✅ Ready to merge']),
      );
      publisher.observeAttention(createAttentionStatus('action_required'));
      publisher.observeAttention(createAttentionStatus('ready'));
      releaseFirst();
      await vi.waitFor(() => expect(bodies).toHaveLength(3));
      await publisher.shutdown();

      expect(bodies).toEqual([
        'robhowley/pi-userland PR #170 · ✅ Ready to merge',
        'robhowley/pi-userland PR #170 · ❌ Required checks are failing',
        'robhowley/pi-userland PR #170 · ✅ Ready to merge',
      ]);
    });

    it('shutdown rejects new work, drops queued notifications, waits active transport, and clears last', async () => {
      let releaseNotification!: () => void;
      const activeNotification = new Promise<void>((resolve) => {
        releaseNotification = resolve;
      });
      const operations: string[] = [];
      const run = createRunMock(async (_command, args) => {
        const operation = args[2]!;
        operations.push(operation);
        if (operation === 'notify') {
          await activeNotification;
        }
      });
      const publisher = createPublisher({ run })!;

      publisher.enqueue({ kind: 'set', value: 'current pill' });
      publisher.observeAttention(createAttentionStatus('waiting'));
      publisher.observeAttention(createAttentionStatus('ready'));
      await vi.waitFor(() => expect(operations).toContain('notify'));
      publisher.observeAttention(createAttentionStatus('action_required'));
      const shutdown = publisher.shutdown();
      publisher.enqueue({ kind: 'set', value: 'late pill' });
      publisher.observeAttention(createAttentionStatus('ready'));
      expect(operations).not.toContain('clear-status');
      releaseNotification();
      await shutdown;

      expect(operations.filter((operation) => operation === 'notify')).toHaveLength(1);
      expect(operations.at(-1)).toBe('clear-status');
      expect(run.mock.calls.some(([, args]) => args.includes('late pill'))).toBe(false);
    });
  });
});
