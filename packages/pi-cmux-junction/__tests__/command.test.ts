import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getJunctionArgumentCompletions,
  parseJunctionArgs,
  registerJunctionCommand,
  runJunctionCommand,
} from '../extensions/cmux-junction/command.js';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';
import type { WorktreeOptions, WorktreePlan } from '../extensions/cmux-junction/worktree.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const PLAN: WorktreePlan = {
  ok: true,
  branch: 'feature/test',
  path: '/tmp/project-wt-feature-test',
  baseRef: 'origin/main',
  baseSha: 'abc123',
  repository: {
    topLevel: '/tmp/project',
    commonGitDir: '/tmp/project/.git',
    repoLabel: 'project',
  },
};

const WORKTREE = {
  ok: true as const,
  status: 'created' as const,
  branch: PLAN.branch,
  path: PLAN.path,
  baseRef: PLAN.baseRef,
};

describe('/junction command', () => {
  it('completes the branch flag from partial input', () => {
    expect(getJunctionArgumentCompletions('--b')).toEqual([
      {
        value: '--branch',
        label: '--branch',
        description: 'Branch to create or reuse',
      },
    ]);
    expect(getJunctionArgumentCompletions('  --b')).toEqual(getJunctionArgumentCompletions('--b'));
    expect(getJunctionArgumentCompletions('--branch ')).toBeNull();
    expect(getJunctionArgumentCompletions('--unknown')).toBeNull();
  });

  it('completes the fork subcommand and its branch flag', () => {
    expect(getJunctionArgumentCompletions('f')).toEqual([
      {
        value: 'fork',
        label: 'fork',
        description: 'Fork the current persisted session',
      },
    ]);
    expect(getJunctionArgumentCompletions('fork --b')).toEqual([
      {
        value: '--branch',
        label: '--branch',
        description: 'Branch to create or reuse',
      },
    ]);
    expect(getJunctionArgumentCompletions('fork --branch ')).toBeNull();
  });

  it.each([
    '',
    '--branch',
    '--branch one two',
    '--branch one --branch two',
    '--branch --unknown',
    '--unknown one',
    'one',
    '--branch=one',
  ])('strictly rejects malformed input: %j', (args) => {
    const result = parseJunctionArgs(args);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.message).toContain('Usage: /junction --branch <name>');
    }
  });

  it('trims and returns the exact branch value', () => {
    expect(parseJunctionArgs('  --branch feature/Keep-Case  ')).toEqual({
      ok: true,
      branch: 'feature/Keep-Case',
    });
  });

  it('parses the strict fork grammar', () => {
    expect(parseJunctionArgs(' fork --branch feature/forked ')).toEqual({
      ok: true,
      mode: 'fork',
      branch: 'feature/forked',
    });
    for (const args of ['fork', 'fork --branch', 'fork --branch one two', 'fork --unknown one']) {
      expect(parseJunctionArgs(args)).toMatchObject({ ok: false });
    }
  });

  it('resolves planning from ctx.cwd and preflights before Git apply', async () => {
    const order: string[] = [];
    const plan = vi.fn(async (cwd: string) => {
      order.push(`plan:${cwd}`);
      return PLAN;
    });
    const preflight = vi.fn(async () => {
      order.push('preflight');
      return { ok: true as const };
    });
    const apply = vi.fn(async () => {
      order.push('apply');
      return WORKTREE;
    });
    const launch = vi.fn(async () => {
      order.push('launch');
      return { ok: true as const };
    });

    await expect(
      runJunctionCommand('--branch feature/test', '/repo/subdirectory', {
        plan,
        preflight,
        apply,
        launch,
      }),
    ).resolves.toMatchObject({ ok: true, status: 'created-and-launched' });
    expect(order).toEqual(['plan:/repo/subdirectory', 'preflight', 'apply', 'launch']);
  });

  it('passes env and homeDir into worktree planning and apply', async () => {
    const env = {
      PATH: '/usr/bin',
      PI_CMUX_JUNCTION_WORKTREE_ROOT: '~/junction-worktrees',
    };
    const homeDir = '/tmp/pi-cmux-junction-home';
    let plannedOptions: WorktreeOptions | undefined;
    let appliedOptions: WorktreeOptions | undefined;
    const plan = async (_cwd: string, _branch: string, options: WorktreeOptions = {}) => {
      plannedOptions = options;
      return PLAN;
    };
    const apply = async (_plan: WorktreePlan, options: WorktreeOptions = {}) => {
      appliedOptions = options;
      return WORKTREE;
    };

    await expect(
      runJunctionCommand('--branch feature/test', '/repo', {
        env,
        homeDir,
        plan,
        preflight: async () => ({ ok: true }),
        apply,
        launch: async () => ({ ok: true }),
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(plannedOptions).toMatchObject({ env, homeDir });
    expect(appliedOptions).toMatchObject({ env, homeDir });
  });

  it('waits for idle and rejects an absent source before any Git work', async () => {
    const waitForIdle = vi.fn(async () => undefined);
    const plan = vi.fn(async () => PLAN);
    const apply = vi.fn();
    const launch = vi.fn();

    const result = await runJunctionCommand(
      'fork --branch feature/test',
      '/repo',
      { plan, apply, launch },
      {
        waitForIdle,
        sessionManager: { getSessionFile: () => undefined },
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'source-session-failed' });
    if (result.ok) throw new Error('Expected source validation to fail.');
    expect(result.message).toContain('persisted session');
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an unreadable source before planning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'unreadable.jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');
    await chmod(sourceSessionFile, 0o000);

    const plan = vi.fn(async () => PLAN);
    const result = await runJunctionCommand(
      'fork --branch feature/test',
      '/repo',
      { plan },
      {
        waitForIdle: async () => undefined,
        sessionManager: { getSessionFile: () => sourceSessionFile },
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'source-session-failed' });
    if (result.ok) throw new Error('Expected unreadable source validation to fail.');
    expect(result.message).toContain('absent or unreadable');
    expect(plan).not.toHaveBeenCalled();
  });

  it('captures a readable absolute source and passes it as a fork recipe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'source;$(unsafe).jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');

    const order: string[] = [];
    const waitForIdle = vi.fn(async () => {
      order.push('idle');
    });
    const plan = vi.fn(async () => {
      order.push('plan');
      return PLAN;
    });
    const preflight = vi.fn(async () => {
      order.push('preflight');
      return { ok: true as const };
    });
    const apply = vi.fn(async () => {
      order.push('apply');
      return WORKTREE;
    });
    const launch = vi.fn(async () => {
      order.push('launch');
      return { ok: true as const };
    });
    const environmentBefore = { ...process.env };

    await expect(
      runJunctionCommand(
        'fork --branch feature/test',
        '/repo',
        { plan, preflight, apply, launch },
        {
          waitForIdle,
          sessionManager: { getSessionFile: () => sourceSessionFile },
        },
      ),
    ).resolves.toMatchObject({ ok: true, status: 'created-and-launched' });

    expect(order).toEqual(['idle', 'plan', 'preflight', 'apply', 'launch']);
    expect(launch).toHaveBeenCalledWith(PLAN.branch, PLAN.path, expect.any(Object), {
      mode: 'fork',
      sourceSessionFile,
    });
    expect(process.env).toEqual(environmentBefore);
  });

  it('does not apply Git when cmux preflight fails', async () => {
    const apply = vi.fn();
    const launch = vi.fn();

    await expect(
      runJunctionCommand('--branch feature/test', '/repo', {
        plan: async () => PLAN,
        preflight: async () => ({
          ok: false,
          reason: 'cmux-unavailable',
          message: 'cmux unavailable; no worktree was created.',
        }),
        apply,
        launch,
      }),
    ).resolves.toMatchObject({ ok: false, status: 'preflight-failed' });
    expect(apply).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('retains and reports a created worktree with exact retry guidance on cmux failure', async () => {
    const result = await runJunctionCommand('--branch feature/test', '/repo', {
      plan: async () => PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => WORKTREE,
      launch: async () => ({ ok: false, reason: 'launch-failed', message: 'boom' }),
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-failed',
      branch: 'feature/test',
      path: '/tmp/project-wt-feature-test',
      worktreeRetained: true,
      message:
        'Worktree retained after cmux launch failed: boom\nBranch: feature/test\nPath: /tmp/project-wt-feature-test\nRetry: /junction --branch feature/test',
    });
  });

  it('preserves the fork command in retry guidance after a retained worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'source.jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');

    const result = await runJunctionCommand(
      'fork --branch feature/test',
      '/repo',
      {
        plan: async () => PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => WORKTREE,
        launch: async () => ({ ok: false, reason: 'launch-failed', message: 'boom' }),
      },
      {
        waitForIdle: async () => undefined,
        sessionManager: { getSessionFile: () => sourceSessionFile },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'partial-launch-failed',
      worktreeRetained: true,
    });
    if (result.ok) throw new Error('Expected cmux launch to fail.');
    expect(result.message).toContain('Retry: /junction fork --branch feature/test');
  });

  it('maps an ambiguous real cmux launch without retry guidance', async () => {
    const runner: ProcessRunner = async () => ({
      outcome: 'timeout',
      timeoutMs: 10_000,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    });

    const result = await runJunctionCommand('--branch feature/test', '/repo', {
      env: {},
      runner,
      plan: async () => PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => WORKTREE,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial-launch-unknown',
      branch: PLAN.branch,
      path: PLAN.path,
      worktreeRetained: true,
      retrySafe: false,
    });
    if (result.ok) throw new Error('Expected launch to be unknown.');
    expect(result.message).toContain('workspace may exist');
    expect(result.message).toContain(`Path: ${PLAN.path}`);
    expect(result.message).not.toContain('Retry:');
  });

  it('does not launch when worktree apply returns an unknown partial state', async () => {
    const launch = vi.fn();
    await expect(
      runJunctionCommand('--branch feature/test', '/repo', {
        plan: async () => PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => ({
          ok: false,
          reason: 'git-add-unknown',
          message: 'inspect Git state',
        }),
        launch,
      }),
    ).resolves.toMatchObject({ ok: false, status: 'worktree-failed' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches a new cmux workspace after worktree reuse', async () => {
    const launch = vi.fn(async () => ({ ok: true as const }));

    await expect(
      runJunctionCommand('--branch feature/test', '/repo', {
        plan: async () => PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => ({ ...WORKTREE, status: 'reused' }),
        launch,
      }),
    ).resolves.toMatchObject({ ok: true, status: 'reused-and-launched' });
    expect(launch).toHaveBeenCalledWith(
      'feature/test',
      '/tmp/project-wt-feature-test',
      expect.any(Object),
    );
  });

  it('notifies successful creation with branch and path', async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, options) => {
        handler = options.handler;
      }),
    };
    const notify = vi.fn();

    registerJunctionCommand(pi, {
      plan: async () => PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => WORKTREE,
      launch: async () => ({ ok: true }),
    });
    await handler?.('--branch feature/test', {
      cwd: '/repo',
      ui: { notify },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      'Created worktree and launched cmux workspace.\nBranch: feature/test\nPath: /tmp/project-wt-feature-test',
      'info',
    );
  });
});
