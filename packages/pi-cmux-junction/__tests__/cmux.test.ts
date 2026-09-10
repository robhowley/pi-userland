import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceCreateArgs,
  launchCmuxTab,
  launchCmuxWorkspace,
  preflightCmux,
  preflightCmuxTab,
  resolveCmuxTarget,
  type CmuxLaunchRecipe,
  type CmuxTabCaller,
} from '../extensions/cmux-junction/cmux.js';
import type { ProcessResult, ProcessRunner } from '../extensions/cmux-junction/process.js';

const CALLER_ENV = {
  PATH: '/usr/bin',
  CMUX_WORKSPACE_ID: 'workspace-1',
  CMUX_SURFACE_ID: 'surface-1',
};
const TAB_SOCKET = '/tmp/cmux.sock';
const TAB_SURFACE = '11111111-1111-4111-8111-111111111111';
const TAB_WORKSPACE_STALE = '22222222-2222-4222-8222-222222222222';
const TAB_WORKSPACE_ONE = '33333333-3333-4333-8333-333333333333';
const TAB_WORKSPACE_TWO = '44444444-4444-4444-8444-444444444444';
const TAB_WINDOW_ONE = '55555555-5555-4555-8555-555555555555';
const TAB_WINDOW_TWO = '66666666-6666-4666-8666-666666666666';
const TAB_PANE_ONE = '77777777-7777-4777-8777-777777777777';
const TAB_PANE_TWO = '88888888-8888-4888-8888-888888888888';
const TAB_ENV = {
  PATH: '/usr/bin:/bin',
  CMUX_SOCKET_PATH: TAB_SOCKET,
  CMUX_WORKSPACE_ID: TAB_WORKSPACE_STALE,
  CMUX_SURFACE_ID: TAB_SURFACE,
};
const TAB_CALLER: CmuxTabCaller = {
  socketPath: TAB_SOCKET,
  workspaceId: TAB_WORKSPACE_ONE,
  surfaceId: TAB_SURFACE,
  windowId: TAB_WINDOW_ONE,
  paneId: TAB_PANE_ONE,
};
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function successfulRunner() {
  const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
  const runner: ProcessRunner = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return { outcome: 'exit', stdout: '', stderr: '', exitCode: 0 };
  };
  return { calls, runner };
}

async function executableFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-cmux-'));
  tempDirectories.push(directory);
  const path = join(directory, 'cmux');
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

function resolvedTarget(workspaceId: string) {
  return JSON.stringify({ source: 'surface', workspace_id: workspaceId, surface_id: TAB_SURFACE });
}

function callerIdentity(
  workspaceId: string,
  windowId: string,
  paneId: string,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    caller: {
      window_id: windowId,
      workspace_id: workspaceId,
      pane_id: paneId,
      surface_id: TAB_SURFACE,
      surface_type: 'terminal',
      is_browser_surface: false,
      ...overrides,
    },
    focused: {
      window_id: '99999999-9999-4999-8999-999999999999',
      workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pane_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      surface_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      surface_type: 'terminal',
      is_browser_surface: false,
    },
  });
}

function runExecutable(file: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, { cwd, env }, (error) => (error === null ? resolve() : reject(error)));
  });
}

async function currentTabDirectories(): Promise<Set<string>> {
  const entries = await readdir('/tmp');
  return new Set(entries.filter((entry) => entry.startsWith('pi-cmux-junction-tab-')));
}

async function newTabDirectory(before: Set<string>, marker: string): Promise<string> {
  const entries = await readdir('/tmp');
  const candidates = entries.filter(
    (entry) => entry.startsWith('pi-cmux-junction-tab-') && !before.has(entry),
  );
  const matches: string[] = [];
  for (const entry of candidates) {
    const directory = join('/tmp', entry);
    const script = await readFile(join(directory, 'launch.sh'), 'utf8').catch(() => '');
    if (script.includes(marker)) matches.push(directory);
  }
  expect(matches).toHaveLength(1);
  const directory = matches[0] ?? '/tmp/missing';
  tempDirectories.push(directory);
  return directory;
}

describe('cmux boundary', () => {
  it.each([
    [{ CMUX_WORKSPACE_ID: '', CMUX_SURFACE_ID: 'surface' }],
    [{ CMUX_WORKSPACE_ID: 'workspace', CMUX_SURFACE_ID: '   ' }],
    [{}],
  ])('requires nonblank inherited caller markers', async (env) => {
    const runner = vi.fn<ProcessRunner>();

    await expect(preflightCmux('/repo', { env, runner })).resolves.toMatchObject({
      ok: false,
      reason: 'missing-caller',
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('checks read-only cmux capabilities before checking Pi', async () => {
    const { calls, runner } = successfulRunner();

    await expect(preflightCmux('/repo', { env: CALLER_ENV, runner })).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual([
      { file: 'cmux', args: ['capabilities'], cwd: '/repo' },
      { file: 'which', args: ['pi'], cwd: '/repo' },
    ]);
  });

  it('resolves an inherited surface through cmux using the workspace as a hint', async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
    const runner: ProcessRunner = async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        outcome: 'exit',
        stdout: JSON.stringify({
          source: 'surface',
          workspace_id: 'workspace-live',
          surface_id: 'surface-1',
        }),
        stderr: '',
        exitCode: 0,
      };
    };

    await expect(
      resolveCmuxTarget(
        '/repo',
        {
          socketPath: '  /tmp/cmux.sock  ',
          workspaceId: 'workspace-stale',
          surfaceId: 'surface-1',
        },
        { env: CALLER_ENV, runner },
      ),
    ).resolves.toEqual({
      ok: true,
      socketPath: '/tmp/cmux.sock',
      workspaceId: 'workspace-live',
      surfaceId: 'surface-1',
    });
    expect(calls).toEqual([
      {
        file: 'cmux',
        args: [
          '--socket',
          '/tmp/cmux.sock',
          'rpc',
          'agent.resolve_delivery_target',
          '{"surface_id":"surface-1","workspace_id":"workspace-stale"}',
        ],
        options: {
          cwd: '/repo',
          env: CALLER_ENV,
          shell: false,
          timeoutMs: 2_000,
          maxBufferBytes: 64 * 1024,
        },
      },
    ]);
  });

  it.each([
    {
      name: 'nonzero exit',
      result: { outcome: 'exit', stdout: '{}', stderr: 'rpc failed', exitCode: 1 } as const,
    },
    {
      name: 'timeout',
      result: {
        outcome: 'timeout',
        stdout: '',
        stderr: '',
        timeoutMs: 2_000,
        signal: 'SIGTERM',
      } as const,
    },
    {
      name: 'malformed output',
      result: { outcome: 'exit', stdout: '{not-json', stderr: '', exitCode: 0 } as const,
    },
    {
      name: 'wrong source',
      result: {
        outcome: 'exit',
        stdout: JSON.stringify({
          source: 'workspace',
          workspace_id: 'workspace-live',
          surface_id: 'surface-1',
        }),
        stderr: '',
        exitCode: 0,
      } as const,
    },
    {
      name: 'missing workspace',
      result: {
        outcome: 'exit',
        stdout: JSON.stringify({ source: 'surface', surface_id: 'surface-1' }),
        stderr: '',
        exitCode: 0,
      } as const,
    },
    {
      name: 'mismatched surface',
      result: {
        outcome: 'exit',
        stdout: JSON.stringify({
          source: 'surface',
          workspace_id: 'workspace-live',
          surface_id: 'surface-other',
        }),
        stderr: '',
        exitCode: 0,
      } as const,
    },
  ])('fails closed for $name', async ({ result }) => {
    const runner: ProcessRunner = async () => result;

    await expect(
      resolveCmuxTarget(
        '/repo',
        { socketPath: '/tmp/cmux.sock', workspaceId: 'workspace-stale', surfaceId: 'surface-1' },
        { env: CALLER_ENV, runner },
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it('uses an executable bundled cmux path for both preflight and launch', async () => {
    const bundled = await executableFile();
    const { calls, runner } = successfulRunner();
    const env = { ...CALLER_ENV, CMUX_BUNDLED_CLI_PATH: `  ${bundled}  ` };

    await expect(preflightCmux('/repo', { env, runner })).resolves.toEqual({ ok: true });
    await expect(
      launchCmuxWorkspace('feature/test', '/worktree', { env, runner }),
    ).resolves.toEqual({
      ok: true,
    });

    expect(calls.filter((call) => call.args[0] === 'capabilities')[0]?.file).toBe(bundled);
    expect(calls.find((call) => call.args[0] === 'workspace')?.file).toBe(bundled);
  });

  it.each(['missing', 'not-executable'] as const)(
    'falls back to cmux when the bundled path is %s',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-cmux-'));
      tempDirectories.push(directory);
      const bundled = join(directory, 'cmux');
      if (kind === 'not-executable') await writeFile(bundled, '#!/bin/sh\nexit 0\n');
      const { calls, runner } = successfulRunner();
      const env = { ...CALLER_ENV, CMUX_BUNDLED_CLI_PATH: bundled };

      await preflightCmux('/repo', { env, runner });
      await launchCmuxWorkspace('feature/test', '/worktree', { env, runner });

      expect(calls.filter((call) => call.file === 'cmux')).toHaveLength(2);
    },
  );

  it('stops when cmux capability discovery fails', async () => {
    const runner: ProcessRunner = async () => ({
      outcome: 'exit',
      stdout: '',
      stderr: 'cmux unavailable',
      exitCode: 1,
    });

    await expect(preflightCmux('/repo', { env: CALLER_ENV, runner })).resolves.toMatchObject({
      ok: false,
      reason: 'cmux-unavailable',
    });
  });

  it('builds and runs the exact unfocused workspace argv from the worktree cwd', async () => {
    const { calls, runner } = successfulRunner();
    const activeAgentDir = '/tmp/pi agent;$(touch should-not-run)';
    const args = buildWorkspaceCreateArgs(
      'feature/Ship-It',
      '/tmp/repo-wt-feature-ship-it',
      activeAgentDir,
    );

    expect(args).toEqual([
      'workspace',
      'create',
      '--name',
      'feature/Ship-It',
      '--cwd',
      '/tmp/repo-wt-feature-ship-it',
      '--env',
      `PI_CODING_AGENT_DIR=${activeAgentDir}`,
      '--command',
      'exec pi',
      '--focus',
      'false',
    ]);
    expect(args.filter((arg) => arg.includes(activeAgentDir))).toEqual([
      `PI_CODING_AGENT_DIR=${activeAgentDir}`,
    ]);
    expect(args).not.toContain('--window');

    await expect(
      launchCmuxWorkspace('feature/Ship-It', '/tmp/repo-wt-feature-ship-it', {
        env: CALLER_ENV,
        runner,
        activeAgentDir,
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ file: 'cmux', args, cwd: '/tmp/repo-wt-feature-ship-it' }]);
  });

  it('transports a fork source as one env argv without interpolating it into the command', async () => {
    const { calls, runner } = successfulRunner();
    const activeAgentDir = '/tmp/pi agent;$(touch should-not-run)';
    const sourceSessionFile = '/tmp/source;$(touch should-not-run).jsonl';
    const recipe = { mode: 'fork' as const, sourceSessionFile };
    const args = buildWorkspaceCreateArgs(
      'feature/Ship-It',
      '/tmp/repo-wt-feature-ship-it',
      activeAgentDir,
      recipe,
    );

    expect(args).toEqual([
      'workspace',
      'create',
      '--name',
      'feature/Ship-It',
      '--cwd',
      '/tmp/repo-wt-feature-ship-it',
      '--env',
      `PI_CODING_AGENT_DIR=${activeAgentDir}`,
      '--env',
      `PI_CMUX_JUNCTION_SOURCE_SESSION=${sourceSessionFile}`,
      '--command',
      'exec pi --fork "$PI_CMUX_JUNCTION_SOURCE_SESSION"',
      '--focus',
      'false',
    ]);
    expect(args.filter((arg) => arg.includes(activeAgentDir))).toEqual([
      `PI_CODING_AGENT_DIR=${activeAgentDir}`,
    ]);
    expect(args.filter((arg) => arg.startsWith('PI_CMUX_JUNCTION_SOURCE_SESSION='))).toHaveLength(
      1,
    );
    expect(args).not.toContain('--window');

    await expect(
      launchCmuxWorkspace(
        'feature/Ship-It',
        '/tmp/repo-wt-feature-ship-it',
        {
          env: CALLER_ENV,
          runner,
          activeAgentDir,
        },
        recipe,
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ file: 'cmux', args, cwd: '/tmp/repo-wt-feature-ship-it' }]);
  });

  it.each([
    [{ outcome: 'timeout', timeoutMs: 10_000, signal: 'SIGTERM', stdout: '', stderr: '' } as const],
    [{ outcome: 'signal', signal: 'SIGTERM', stdout: '', stderr: '' } as const],
  ])('reports timeout or signal launch as unknown', async (processResult) => {
    const runner: ProcessRunner = async () => processResult;
    await expect(
      launchCmuxWorkspace('feature/test', '/worktree', { env: CALLER_ENV, runner }),
    ).resolves.toMatchObject({ ok: false, reason: 'launch-unknown' });
  });
});

describe('cmux tab boundary', () => {
  it('requires all caller markers before running the existing preflight', async () => {
    const runner = vi.fn<ProcessRunner>();

    await expect(
      preflightCmuxTab('/repo', {
        env: { ...TAB_ENV, CMUX_SOCKET_PATH: '  ' },
        runner,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'missing-caller' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('rehomes a stale claim, then resolves the moved caller again immediately before create', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    let resolution = 0;
    let sendScript = '';
    const runner: ProcessRunner = async (_file, args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (args[0] === 'capabilities' || args[0] === 'pi') {
        return { outcome: 'exit', stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[2] === 'rpc') {
        resolution += 1;
        return {
          outcome: 'exit',
          stdout: resolvedTarget(resolution === 1 ? TAB_WORKSPACE_ONE : TAB_WORKSPACE_TWO),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[2] === 'identify') {
        return {
          outcome: 'exit',
          stdout:
            resolution === 1
              ? callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE)
              : callerIdentity(TAB_WORKSPACE_TWO, TAB_WINDOW_TWO, TAB_PANE_TWO),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[2] === 'new-surface') {
        return {
          outcome: 'exit',
          stdout: 'OK surface:115 pane:47 workspace:27\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[2] === 'send') {
        sendScript = args[7] ?? '';
        tempDirectories.push(dirname(sendScript.slice(0, -2)));
        return {
          outcome: 'exit',
          stdout: 'OK surface:115 workspace:27\n',
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`unexpected argv: ${args.join(' ')}`);
    };

    const preflight = await preflightCmuxTab('/repo', { env: TAB_ENV, runner });
    expect(preflight).toEqual({ ok: true, caller: TAB_CALLER });
    if (!preflight.ok) throw new Error('preflight failed');

    await expect(
      launchCmuxTab('/worktree', preflight.caller, {
        env: TAB_ENV,
        runner,
        activeAgentDir: '/agent',
      }),
    ).resolves.toEqual({
      ok: true,
      mutation: 'exists',
      surfaceRef: 'surface:115',
      target: {
        socketPath: TAB_SOCKET,
        workspaceId: TAB_WORKSPACE_TWO,
        surfaceId: TAB_SURFACE,
        windowId: TAB_WINDOW_TWO,
        paneId: TAB_PANE_TWO,
      },
    });

    expect(calls.map((call) => call.args)).toEqual([
      ['capabilities'],
      ['pi'],
      [
        '--socket',
        TAB_SOCKET,
        'rpc',
        'agent.resolve_delivery_target',
        JSON.stringify({ surface_id: TAB_SURFACE, workspace_id: TAB_WORKSPACE_STALE }),
      ],
      [
        '--socket',
        TAB_SOCKET,
        'identify',
        '--id-format',
        'both',
        '--json',
        '--workspace',
        TAB_WORKSPACE_ONE,
        '--surface',
        TAB_SURFACE,
      ],
      [
        '--socket',
        TAB_SOCKET,
        'rpc',
        'agent.resolve_delivery_target',
        JSON.stringify({ surface_id: TAB_SURFACE, workspace_id: TAB_WORKSPACE_ONE }),
      ],
      [
        '--socket',
        TAB_SOCKET,
        'identify',
        '--id-format',
        'both',
        '--json',
        '--workspace',
        TAB_WORKSPACE_TWO,
        '--surface',
        TAB_SURFACE,
      ],
      [
        '--socket',
        TAB_SOCKET,
        'new-surface',
        '--type',
        'terminal',
        '--placement',
        'workspace',
        '--window',
        TAB_WINDOW_TWO,
        '--workspace',
        TAB_WORKSPACE_TWO,
        '--pane',
        TAB_PANE_TWO,
        '--working-directory',
        '/worktree',
        '--focus',
        'false',
      ],
      [
        '--socket',
        TAB_SOCKET,
        'send',
        '--workspace',
        TAB_WORKSPACE_TWO,
        '--surface',
        'surface:115',
        sendScript,
      ],
    ]);
    expect(sendScript).toMatch(/^\/tmp\/pi-cmux-junction-tab-[A-Za-z0-9]+\/launch\.sh\\r$/);
    expect(sendScript.endsWith('\\r')).toBe(true);
    expect(calls.filter((call) => call.args[2] === 'new-surface')).toHaveLength(1);
    expect(calls.filter((call) => call.args[2] === 'send')).toHaveLength(1);
    expect(calls.flatMap((call) => call.args)).not.toContain('tree');
    expect(calls.flatMap((call) => call.args)).not.toContain('send-key');
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['array shape', '[]'],
    [
      'focused-only arbitrary target',
      JSON.stringify({
        focused: JSON.parse(callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE)).caller,
      }),
    ],
    [
      'wrong surface UUID',
      callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE, {
        surface_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }),
    ],
    [
      'wrong workspace UUID',
      callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE, {
        workspace_id: TAB_WORKSPACE_TWO,
      }),
    ],
    [
      'malformed window UUID',
      callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE, {
        window_id: 'focused-window',
      }),
    ],
    [
      'malformed pane UUID',
      callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE, {
        pane_id: null,
      }),
    ],
    [
      'non-terminal surface',
      callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE, {
        surface_type: 'browser',
      }),
    ],
    [
      'browser terminal contradiction',
      callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE, {
        is_browser_surface: true,
      }),
    ],
  ])('rejects identify response: %s', async (_name, identifyStdout) => {
    const calls: readonly string[][] = [];
    const runner: ProcessRunner = async (_file, args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === 'capabilities' || args[0] === 'pi') {
        return { outcome: 'exit', stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[2] === 'rpc') {
        return {
          outcome: 'exit',
          stdout: resolvedTarget(TAB_WORKSPACE_ONE),
          stderr: '',
          exitCode: 0,
        };
      }
      return { outcome: 'exit', stdout: identifyStdout, stderr: '', exitCode: 0 };
    };

    await expect(preflightCmuxTab('/repo', { env: TAB_ENV, runner })).resolves.toMatchObject({
      ok: false,
      reason: 'caller-unavailable',
    });
    expect(calls.at(-1)).toEqual([
      '--socket',
      TAB_SOCKET,
      'identify',
      '--id-format',
      'both',
      '--json',
      '--workspace',
      TAB_WORKSPACE_ONE,
      '--surface',
      TAB_SURFACE,
    ]);
  });

  it.each([
    {
      name: 'create runner cannot spawn',
      create: {
        outcome: 'spawn-failed',
        message: 'ENOENT secret-agent',
        code: 'ENOENT',
        stdout: '',
        stderr: '',
      } as ProcessResult,
      mutation: 'none',
    },
    {
      name: 'executed create exits nonzero',
      create: {
        outcome: 'exit',
        stdout: '',
        stderr: 'secret-agent secret-source',
        exitCode: 1,
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'executed create times out',
      create: {
        outcome: 'timeout',
        timeoutMs: 10_000,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'executed create is signaled',
      create: {
        outcome: 'signal',
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'zero exit omits newline',
      create: {
        outcome: 'exit',
        stdout: 'OK surface:115 pane:47 workspace:27',
        stderr: '',
        exitCode: 0,
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'zero exit has trailing output',
      create: {
        outcome: 'exit',
        stdout: 'OK surface:115 pane:47 workspace:27\n\n',
        stderr: '',
        exitCode: 0,
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'zero exit has a zero ref',
      create: {
        outcome: 'exit',
        stdout: 'OK surface:0 pane:47 workspace:27\n',
        stderr: '',
        exitCode: 0,
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'zero exit returns JSON',
      create: {
        outcome: 'exit',
        stdout: '{"surface":"surface:115"}\n',
        stderr: '',
        exitCode: 0,
      } as ProcessResult,
      mutation: 'may-exist',
    },
    {
      name: 'proven stdout has stderr',
      create: {
        outcome: 'exit',
        stdout: 'OK surface:115 pane:47 workspace:27\n',
        stderr: 'warning',
        exitCode: 0,
      } as ProcessResult,
      mutation: 'may-exist',
    },
  ])('classifies $name without retry or send', async ({ name, create, mutation }) => {
    const before = await currentTabDirectories();
    const secretAgent = `secret-agent-${process.pid}-${name}`;
    let stagedDirectory = '';
    let creates = 0;
    let sends = 0;
    const runner: ProcessRunner = async (_file, args) => {
      if (args[2] === 'rpc') {
        return {
          outcome: 'exit',
          stdout: resolvedTarget(TAB_WORKSPACE_ONE),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[2] === 'identify') {
        return {
          outcome: 'exit',
          stdout: callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[2] === 'new-surface') {
        creates += 1;
        stagedDirectory = await newTabDirectory(before, secretAgent);
        return create;
      }
      sends += 1;
      return { outcome: 'exit', stdout: '', stderr: '', exitCode: 0 };
    };

    const result = await launchCmuxTab(
      '/worktree',
      TAB_CALLER,
      {
        env: TAB_ENV,
        runner,
        activeAgentDir: secretAgent,
      },
      { mode: 'fork', sourceSessionFile: 'secret-source' },
    );

    expect(result).toMatchObject({ ok: false, mutation });
    expect(creates).toBe(1);
    expect(sends).toBe(0);
    if (mutation === 'none') {
      await expect(stat(stagedDirectory)).rejects.toThrow();
    } else {
      await expect(stat(join(stagedDirectory, 'launch.sh'))).resolves.toMatchObject({
        mode: expect.any(Number),
      });
      expect(result).toMatchObject({ target: TAB_CALLER });
    }
    expect(JSON.stringify(result)).not.toContain(secretAgent);
    expect(JSON.stringify(result)).not.toContain('secret-source');
  });

  it('treats a thrown create runner as may-exist and leaves the script untouched', async () => {
    const before = await currentTabDirectories();
    const activeAgentDir = `thrown-create-${process.pid}`;
    let stagedDirectory = '';
    const runner: ProcessRunner = async (_file, args) => {
      if (args[2] === 'rpc') {
        return {
          outcome: 'exit',
          stdout: resolvedTarget(TAB_WORKSPACE_ONE),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[2] === 'identify') {
        return {
          outcome: 'exit',
          stdout: callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE),
          stderr: '',
          exitCode: 0,
        };
      }
      stagedDirectory = await newTabDirectory(before, activeAgentDir);
      throw new Error('thrown after spawn');
    };

    await expect(
      launchCmuxTab('/worktree', TAB_CALLER, { env: TAB_ENV, runner, activeAgentDir }),
    ).resolves.toMatchObject({ ok: false, mutation: 'may-exist', target: TAB_CALLER });
    await expect(stat(join(stagedDirectory, 'launch.sh'))).resolves.toBeDefined();
  });

  it.each(['resolution', 'identification'] as const)(
    'cleans the private script when second target %s fails before create',
    async (failure) => {
      const before = await currentTabDirectories();
      const activeAgentDir = `failed-${failure}-${process.pid}`;
      let stagedDirectory = '';
      const runner: ProcessRunner = async (_file, args) => {
        stagedDirectory ||= await newTabDirectory(before, activeAgentDir);
        if (args[2] === 'rpc') {
          return failure === 'resolution'
            ? { outcome: 'exit', stdout: '', stderr: 'failed', exitCode: 1 }
            : {
                outcome: 'exit',
                stdout: resolvedTarget(TAB_WORKSPACE_ONE),
                stderr: '',
                exitCode: 0,
              };
        }
        expect(args[2]).toBe('identify');
        return { outcome: 'exit', stdout: '{bad-json', stderr: '', exitCode: 0 };
      };

      await expect(
        launchCmuxTab('/worktree', TAB_CALLER, { env: TAB_ENV, runner, activeAgentDir }),
      ).resolves.toEqual({
        ok: false,
        mutation: 'none',
        reason: 'caller-unavailable',
        message: 'The invoking cmux terminal could not be re-identified before tab creation.',
      });
      await expect(stat(stagedDirectory)).rejects.toThrow();
    },
  );

  it('fails staging before any cmux command for a value a shell cannot transport', async () => {
    const runner = vi.fn<ProcessRunner>();

    await expect(
      launchCmuxTab('/worktree', TAB_CALLER, {
        env: TAB_ENV,
        runner,
        activeAgentDir: 'agent\0dir',
      }),
    ).resolves.toMatchObject({ ok: false, mutation: 'none', reason: 'staging-failed' });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    ['nonzero send', false],
    ['thrown send', true],
  ])(
    'reports parsed creation as exists after %s and never removes the script',
    async (_name, throws) => {
      let scriptPath = '';
      let sends = 0;
      const runner: ProcessRunner = async (_file, args) => {
        if (args[2] === 'rpc') {
          return {
            outcome: 'exit',
            stdout: resolvedTarget(TAB_WORKSPACE_ONE),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[2] === 'identify') {
          return {
            outcome: 'exit',
            stdout: callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[2] === 'new-surface') {
          return {
            outcome: 'exit',
            stdout: 'OK surface:115 pane:47 workspace:27\n',
            stderr: '',
            exitCode: 0,
          };
        }
        sends += 1;
        scriptPath = (args[7] ?? '').slice(0, -2);
        tempDirectories.push(dirname(scriptPath));
        if (throws) throw new Error('send threw');
        return { outcome: 'exit', stdout: '', stderr: 'send failed', exitCode: 1 };
      };

      await expect(
        launchCmuxTab('/worktree', TAB_CALLER, { env: TAB_ENV, runner, activeAgentDir: '/agent' }),
      ).resolves.toEqual({
        ok: false,
        mutation: 'exists',
        reason: 'send-failed',
        surfaceRef: 'surface:115',
        target: TAB_CALLER,
        message:
          'cmux created surface:115, but Pi launch submission failed; the tab may be blank or partially launched.',
      });
      expect(sends).toBe(1);
      await expect(stat(scriptPath)).resolves.toBeDefined();
    },
  );

  it.each([
    ['fresh', { mode: 'fresh' } as CmuxLaunchRecipe, []],
    [
      'fork',
      {
        mode: 'fork',
        sourceSessionFile: "/source/session ' ;$(touch should-not-run)\n.jsonl",
      } as CmuxLaunchRecipe,
      ['--fork', "/source/session ' ;$(touch should-not-run)\n.jsonl"],
    ],
  ])(
    'runs the %s recipe through a private self-cleaning script',
    async (_name, recipe, expectedArgs) => {
      const root = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-tab-test-'));
      tempDirectories.push(root);
      const fakeBin = join(root, 'fake-bin');
      const observed = join(root, 'observed');
      const worktreePath = join(root, "worktree ' ;$(touch should-not-run)\npath");
      await mkdir(fakeBin);
      await mkdir(observed);
      await mkdir(worktreePath);
      const fakePi = join(fakeBin, 'pi');
      await writeFile(
        fakePi,
        [
          '#!/bin/sh',
          'printf %s "$PI_CODING_AGENT_DIR" > "$OBSERVED_DIR/agent"',
          'printf %s "${PI_CMUX_JUNCTION_SOURCE_SESSION-}" > "$OBSERVED_DIR/source"',
          'printf %s "$PWD" > "$OBSERVED_DIR/cwd"',
          ': > "$OBSERVED_DIR/args"',
          'for arg do printf \'%s\\n\' "$arg" >> "$OBSERVED_DIR/args"; done',
          '',
        ].join('\n'),
      );
      await chmod(fakePi, 0o755);
      const activeAgentDir = "/agent/dir ' ;$(touch should-not-run)\nvalue";
      const env = { ...TAB_ENV, PATH: `${fakeBin}:/usr/bin:/bin`, OBSERVED_DIR: observed };
      let sendArgs: readonly string[] = [];
      const runner: ProcessRunner = async (_file, args, options) => {
        if (args[2] === 'rpc') {
          return {
            outcome: 'exit',
            stdout: resolvedTarget(TAB_WORKSPACE_ONE),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[2] === 'identify') {
          return {
            outcome: 'exit',
            stdout: callerIdentity(TAB_WORKSPACE_ONE, TAB_WINDOW_ONE, TAB_PANE_ONE),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[2] === 'new-surface') {
          expect(args).toEqual([
            '--socket',
            TAB_SOCKET,
            'new-surface',
            '--type',
            'terminal',
            '--placement',
            'workspace',
            '--window',
            TAB_WINDOW_ONE,
            '--workspace',
            TAB_WORKSPACE_ONE,
            '--pane',
            TAB_PANE_ONE,
            '--working-directory',
            worktreePath,
            '--focus',
            'false',
          ]);
          return {
            outcome: 'exit',
            stdout: 'OK surface:115 pane:47 workspace:27\n',
            stderr: '',
            exitCode: 0,
          };
        }
        sendArgs = args;
        const text = args[7] ?? '';
        expect(text.endsWith('\\r')).toBe(true);
        const scriptPath = text.slice(0, -2);
        expect(scriptPath).toMatch(/^\/tmp\/pi-cmux-junction-tab-[A-Za-z0-9]+\/launch\.sh$/);
        expect((await stat(dirname(scriptPath))).mode & 0o777).toBe(0o700);
        expect((await stat(scriptPath)).mode & 0o777).toBe(0o700);
        await runExecutable(scriptPath, options.cwd, options.env ?? {});
        await expect(stat(scriptPath)).rejects.toThrow();
        await expect(stat(dirname(scriptPath))).rejects.toThrow();
        return {
          outcome: 'exit',
          stdout: 'OK surface:115 workspace:27\n',
          stderr: '',
          exitCode: 0,
        };
      };

      await expect(
        launchCmuxTab(worktreePath, TAB_CALLER, { env, runner, activeAgentDir }, recipe),
      ).resolves.toEqual({
        ok: true,
        mutation: 'exists',
        surfaceRef: 'surface:115',
        target: TAB_CALLER,
      });
      expect(sendArgs).toEqual([
        '--socket',
        TAB_SOCKET,
        'send',
        '--workspace',
        TAB_WORKSPACE_ONE,
        '--surface',
        'surface:115',
        expect.stringMatching(/^\/tmp\/pi-cmux-junction-tab-[A-Za-z0-9]+\/launch\.sh\\r$/),
      ]);
      await expect(readFile(join(observed, 'agent'), 'utf8')).resolves.toBe(activeAgentDir);
      await expect(readFile(join(observed, 'cwd'), 'utf8')).resolves.toBe(
        await realpath(worktreePath),
      );
      await expect(readFile(join(observed, 'args'), 'utf8')).resolves.toBe(
        expectedArgs.length === 0 ? '' : `${expectedArgs.join('\n')}\n`,
      );
      await expect(readFile(join(observed, 'source'), 'utf8')).resolves.toBe(
        recipe.mode === 'fork' ? recipe.sourceSessionFile : '',
      );
      await expect(stat(join(worktreePath, 'should-not-run'))).rejects.toThrow();
    },
  );
});
