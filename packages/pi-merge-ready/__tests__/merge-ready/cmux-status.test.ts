import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCmuxProcessRunner,
  createMergeReadyCmuxAction,
  createMergeReadyCmuxPublisher,
} from '../../extensions/merge-ready/cmux-status.js';
import { createMergeReadyStatus } from '../../extensions/merge-ready/status.js';

const sandboxes: Array<() => void> = [];
type CmuxRun = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

function createRunMock(implementation: CmuxRun = async () => undefined) {
  return vi.fn(implementation);
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
});
