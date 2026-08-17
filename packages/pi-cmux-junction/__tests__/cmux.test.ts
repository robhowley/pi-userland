import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceCreateArgs,
  launchCmuxWorkspace,
  preflightCmux,
} from '../extensions/cmux-junction/cmux.js';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';

const CALLER_ENV = {
  PATH: '/usr/bin',
  CMUX_WORKSPACE_ID: 'workspace-1',
  CMUX_SURFACE_ID: 'surface-1',
};

function successfulRunner() {
  const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
  const runner: ProcessRunner = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { calls, runner };
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

  it('stops when cmux capability discovery fails', async () => {
    const runner: ProcessRunner = async () => ({
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
    expect(calls).toEqual([
      {
        file: 'cmux',
        args,
        cwd: '/tmp/repo-wt-feature-ship-it',
      },
    ]);
  });
});
