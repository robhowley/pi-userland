import { describe, expect, it, vi } from 'vitest';
import {
  getJunctionArgumentCompletions,
  parseJunctionArgs,
  registerJunctionCommand,
  runJunctionCommand,
} from '../extensions/cmux-junction/command.js';
import type { WorktreePlan } from '../extensions/cmux-junction/worktree.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const PLAN: WorktreePlan = {
  ok: true,
  action: 'create',
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

  it('launches a new cmux workspace after worktree reuse', async () => {
    const launch = vi.fn(async () => ({ ok: true as const }));

    await expect(
      runJunctionCommand('--branch feature/test', '/repo', {
        plan: async () => ({ ...PLAN, action: 'reuse' }),
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
