import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceCreateArgs,
  launchCmuxWorkspace,
  preflightCmux,
  resolveCmuxTarget,
} from '../extensions/cmux-junction/cmux.js';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';

const CALLER_ENV = {
  PATH: '/usr/bin',
  CMUX_WORKSPACE_ID: 'workspace-1',
  CMUX_SURFACE_ID: 'surface-1',
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
          socketPath: '/tmp/cmux.sock',
          workspaceId: 'workspace-stale',
          surfaceId: 'surface-1',
        },
        { env: CALLER_ENV, runner },
      ),
    ).resolves.toEqual({
      ok: true,
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
    const args = buildWorkspaceCreateArgs('feature/Ship-It', '/tmp/repo-wt-feature-ship-it');

    expect(args).toEqual([
      'workspace',
      'create',
      '--name',
      'feature/Ship-It',
      '--cwd',
      '/tmp/repo-wt-feature-ship-it',
      '--command',
      'exec pi',
      '--focus',
      'false',
    ]);
    expect(args).not.toContain('--window');

    await expect(
      launchCmuxWorkspace('feature/Ship-It', '/tmp/repo-wt-feature-ship-it', {
        env: CALLER_ENV,
        runner,
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ file: 'cmux', args, cwd: '/tmp/repo-wt-feature-ship-it' }]);
  });

  it('transports a fork source as one env argv without interpolating it into the command', async () => {
    const { calls, runner } = successfulRunner();
    const sourceSessionFile = '/tmp/source;$(touch should-not-run).jsonl';
    const recipe = { mode: 'fork' as const, sourceSessionFile };
    const environmentBefore = { ...process.env };
    const args = buildWorkspaceCreateArgs(
      'feature/Ship-It',
      '/tmp/repo-wt-feature-ship-it',
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
      `PI_CMUX_JUNCTION_SOURCE_SESSION=${sourceSessionFile}`,
      '--command',
      'exec pi --fork "$PI_CMUX_JUNCTION_SOURCE_SESSION"',
      '--focus',
      'false',
    ]);
    expect(args).not.toContain('--window');

    await expect(
      launchCmuxWorkspace(
        'feature/Ship-It',
        '/tmp/repo-wt-feature-ship-it',
        {
          env: CALLER_ENV,
          runner,
        },
        recipe,
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ file: 'cmux', args, cwd: '/tmp/repo-wt-feature-ship-it' }]);
    expect(process.env).toEqual(environmentBefore);
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
