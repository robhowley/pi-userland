import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getJunctionArgumentCompletions,
  parseJunctionArgs,
  registerJunctionCommand,
  runJunctionCommand,
} from '../extensions/cmux-junction/command.js';
import type { ProcessRunner } from '../extensions/cmux-junction/process.js';
import type {
  WorktreeOptions,
  WorktreePlan,
  WorktreeSuccess,
} from '../extensions/cmux-junction/worktree.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

type DefaultWorktreePlan = Extract<WorktreePlan, { kind: 'create-default' }>;
type DefaultWorktreeSuccess = Extract<WorktreeSuccess, { kind: 'create-default' }>;
type CheckoutWorktreePlan = Extract<WorktreePlan, { kind: 'checkout' }>;
type CheckoutWorktreeSuccess = Extract<WorktreeSuccess, { kind: 'checkout' }>;

let cwd: string;
let sourceRoot: string;
let worktreeRoot: string;
let PLAN: DefaultWorktreePlan;
let WORKTREE: DefaultWorktreeSuccess;
let CHECKOUT_PLAN: CheckoutWorktreePlan;
let CHECKOUT_WORKTREE: CheckoutWorktreeSuccess;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-command-'));
  tempDirectories.push(directory);
  sourceRoot = join(directory, 'source');
  worktreeRoot = join(directory, 'worktree');
  await Promise.all([mkdir(sourceRoot), mkdir(worktreeRoot)]);
  sourceRoot = await realpath(sourceRoot);
  worktreeRoot = await realpath(worktreeRoot);
  cwd = sourceRoot;
  PLAN = {
    ok: true,
    kind: 'create-default',
    branch: 'feature/test',
    path: worktreeRoot,
    baseRef: 'origin/main',
    baseSha: 'abc123',
    repository: {
      topLevel: sourceRoot,
      commonGitDir: join(sourceRoot, '.git'),
      repoLabel: 'project',
    },
  };
  WORKTREE = {
    ok: true,
    kind: 'create-default',
    status: 'created',
    branch: PLAN.branch,
    path: PLAN.path,
    baseRef: PLAN.baseRef,
  };
  CHECKOUT_PLAN = {
    ok: true,
    kind: 'checkout',
    branch: 'feature/Keep-Case',
    branchRef: 'refs/heads/feature/Keep-Case',
    path: worktreeRoot,
    repository: PLAN.repository,
  };
  CHECKOUT_WORKTREE = {
    ok: true,
    kind: 'checkout',
    status: 'created',
    branch: CHECKOUT_PLAN.branch,
    path: CHECKOUT_PLAN.path,
  };
});

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

  it('completes checkout only through its branch flag', () => {
    const checkout = {
      value: 'checkout',
      label: 'checkout',
      description: 'Open an existing local branch in a fresh session',
    };
    const branch = {
      value: '--branch',
      label: '--branch',
      description: 'Branch to create or reuse',
    };

    expect(getJunctionArgumentCompletions('')).toEqual([
      expect.objectContaining({ value: 'fork' }),
      checkout,
      branch,
    ]);
    expect(getJunctionArgumentCompletions('c')).toEqual([checkout]);
    expect(getJunctionArgumentCompletions('checkout ')).toEqual([branch]);
    expect(getJunctionArgumentCompletions('checkout --b')).toEqual([branch]);
    for (const input of [
      'checkout --branch ',
      'checkout --branch feature/test',
      'checkout --branch feature/test ',
      'checkout --branch feature/test --f',
      'checkout --branch feature/test --from ',
      'checkout --branch refs/foo',
      'checkout --branch refs/foo ',
      'checkout unknown',
      'checkout fork --branch feature/test',
    ]) {
      expect(getJunctionArgumentCompletions(input)).toBeNull();
    }
  });

  it('offers --from only after a complete branch and HEAD only as a static commit hint', () => {
    const from = {
      value: '--from',
      label: '--from',
      description: 'Create from a committed Git ref; working-tree changes are not copied',
    };
    const head = {
      value: 'HEAD',
      label: 'HEAD',
      description:
        'Current committed commit; staged, unstaged, untracked, and ignored changes are not copied',
    };

    expect(getJunctionArgumentCompletions('--branch feature/test ')).toEqual([from]);
    expect(getJunctionArgumentCompletions('fork --branch feature/test ')).toEqual([from]);
    expect(getJunctionArgumentCompletions('--branch feature/test --f')).toEqual([from]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from ')).toEqual([head]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from H')).toEqual([head]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from HEAD ')).toBeNull();
    expect(
      getJunctionArgumentCompletions('--branch feature/test --from refs/heads/main'),
    ).toBeNull();
    expect(getJunctionArgumentCompletions('--branch --from ')).toBeNull();
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
      mode: 'fresh',
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

  it('parses explicit sources without normalizing the input token', () => {
    expect(parseJunctionArgs('--branch feature/test --from refs/tags/Release-1 ')).toEqual({
      ok: true,
      mode: 'fresh',
      branch: 'feature/test',
      from: 'refs/tags/Release-1',
    });
    expect(parseJunctionArgs('fork --branch feature/test --from HEAD')).toEqual({
      ok: true,
      mode: 'fork',
      branch: 'feature/test',
      from: 'HEAD',
    });
  });

  it('parses only the exact checkout grammar and preserves the local branch name', () => {
    expect(parseJunctionArgs('  checkout --branch Feature/Keep-Case  ')).toEqual({
      ok: true,
      mode: 'checkout',
      branch: 'Feature/Keep-Case',
    });
    expect(parseJunctionArgs('  checkout --branch refs/foo  ')).toEqual({
      ok: true,
      mode: 'checkout',
      branch: 'refs/foo',
    });
  });

  it.each([
    'checkout',
    'checkout --branch',
    'checkout --branch --unknown',
    'checkout --branch=feature/test',
    'checkout --branch feature/test extra',
    'checkout --branch feature/test --branch other',
    'checkout --unknown feature/test',
    'checkout feature/test --branch other',
    'checkout --branch feature/test --from HEAD',
    'checkout --branch feature/test --from=HEAD',
    'checkout --from HEAD --branch feature/test',
    'checkout --branch -option',
    'fork checkout --branch feature/test',
    'checkout fork --branch feature/test',
    'fork --branch feature/test checkout',
    'checkout --branch feature/test fork',
  ])('rejects malformed checkout grammar before orchestration: %j', (args) => {
    const result = parseJunctionArgs(args);
    expect(result).toMatchObject({ ok: false });
  });

  it.each([
    '--branch',
    '--branch --from HEAD',
    '--branch feature/test --from',
    '--branch feature/test --from --unknown',
    '--branch feature/test --from HEAD --from main',
    '--branch feature/test --from HEAD --branch other',
    '--from HEAD --branch feature/test',
    '--branch=feature/test',
    '--branch feature/test --from=HEAD',
    '--branch feature/test positional',
    'fork --from HEAD --branch feature/test',
    'fork --branch feature/test --from HEAD extra',
  ])('rejects malformed explicit grammar: %j', (args) => {
    expect(parseJunctionArgs(args)).toMatchObject({ ok: false });
  });

  it('rejects fork and checkout compositions before reading the fork source', async () => {
    const waitForIdle = vi.fn(async () => undefined);
    const getSessionFile = vi.fn(() => undefined);
    const plan = vi.fn(async () => PLAN);
    const planCheckout = vi.fn(async () => CHECKOUT_PLAN);

    const result = await runJunctionCommand(
      'fork checkout --branch feature/test',
      cwd,
      { plan, planCheckout },
      { waitForIdle, sessionManager: { getSessionFile } },
    );

    expect(result).toMatchObject({ ok: false, status: 'invalid-command' });
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(getSessionFile).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(planCheckout).not.toHaveBeenCalled();
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
      runJunctionCommand('--branch feature/test', cwd, {
        plan,
        preflight,
        apply,
        launch,
      }),
    ).resolves.toMatchObject({ ok: true, status: 'created-and-launched' });
    expect(order).toEqual([`plan:${cwd}`, 'preflight', 'apply', 'launch']);
    expect(launch).toHaveBeenCalledWith(PLAN.branch, worktreeRoot, expect.any(Object));
  });

  it('passes the exact --from token to planning and returns the explicit worktree source', async () => {
    const source = 'refs/tags/Release-1';
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const plan = vi.fn(
      async (_cwd: string, _branch: string, _options: WorktreeOptions, from?: string) => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: from ?? '',
        baseSha: sha,
      }),
    );
    const apply = vi.fn(async () => ({
      ...WORKTREE,
      kind: 'create-explicit' as const,
      status: 'created' as const,
      baseRef: source,
      baseSha: sha,
    }));

    const result = await runJunctionCommand(`--branch feature/test --from ${source}`, cwd, {
      plan,
      preflight: async () => ({ ok: true }),
      apply,
      launch: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'created-and-launched',
      worktree: { kind: 'create-explicit', baseRef: source, baseSha: sha },
    });
    expect(result).not.toHaveProperty('from');
    expect(plan).toHaveBeenCalledWith(cwd, 'feature/test', expect.any(Object), source);
  });

  it('uses the checkout planner and launches a fresh session from the matching relative cwd', async () => {
    const nested = join('packages', 'checkout');
    await Promise.all([
      mkdir(join(sourceRoot, nested), { recursive: true }),
      mkdir(join(worktreeRoot, nested), { recursive: true }),
    ]);
    const nestedCwd = join(sourceRoot, nested);
    const destinationCwd = await realpath(join(worktreeRoot, nested));
    const order: string[] = [];
    const plan = vi.fn(async () => PLAN);
    const planCheckout = vi.fn(async () => {
      order.push('checkout-plan');
      return CHECKOUT_PLAN;
    });
    const preflight = vi.fn(async () => {
      order.push('preflight');
      return { ok: true as const };
    });
    const apply = vi.fn(async () => {
      order.push('apply');
      return CHECKOUT_WORKTREE;
    });
    const launch = vi.fn(async () => {
      order.push('launch');
      return { ok: true as const };
    });
    const waitForIdle = vi.fn(async () => undefined);
    const getSessionFile = vi.fn(() => undefined);
    const env = { PATH: '/usr/bin' };
    const homeDir = '/tmp/pi-cmux-junction-home';

    const result = await runJunctionCommand(
      'checkout --branch feature/Keep-Case',
      nestedCwd,
      { env, homeDir, plan, planCheckout, preflight, apply, launch },
      { waitForIdle, sessionManager: { getSessionFile } },
    );

    expect(result).toEqual({
      ok: true,
      status: 'created-and-launched',
      worktree: CHECKOUT_WORKTREE,
      launchCwd: destinationCwd,
    });
    expect(order).toEqual(['checkout-plan', 'preflight', 'apply', 'launch']);
    expect(planCheckout).toHaveBeenCalledWith(
      nestedCwd,
      'feature/Keep-Case',
      expect.objectContaining({ env, homeDir }),
    );
    expect(plan).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(CHECKOUT_PLAN, expect.objectContaining({ env, homeDir }));
    expect(launch).toHaveBeenCalledWith(
      CHECKOUT_WORKTREE.branch,
      destinationCwd,
      expect.any(Object),
    );
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(getSessionFile).not.toHaveBeenCalled();
  });

  it('maps checkout reuse and missing relative cwd through the shared root fallback', async () => {
    const nested = join('packages', 'missing-checkout');
    await mkdir(join(sourceRoot, nested), { recursive: true });
    const launch = vi.fn(async () => ({ ok: true as const }));
    const reused = { ...CHECKOUT_WORKTREE, status: 'reused' as const };

    const result = await runJunctionCommand(
      'checkout --branch feature/Keep-Case',
      join(sourceRoot, nested),
      {
        planCheckout: async () => CHECKOUT_PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => reused,
        launch,
      },
    );

    expect(result).toEqual({
      ok: true,
      status: 'reused-and-launched',
      worktree: reused,
      launchCwd: worktreeRoot,
      launchCwdWarning: `Could not preserve "${nested}" because it is absent or unsafe in the target worktree; launched at the worktree root.`,
    });
    expect(launch).toHaveBeenCalledWith(CHECKOUT_PLAN.branch, worktreeRoot, expect.any(Object));
  });

  it('launches an existing repository-relative directory through a source path alias', async () => {
    const nested = join('packages', 'app');
    await Promise.all([
      mkdir(join(sourceRoot, nested), { recursive: true }),
      mkdir(join(worktreeRoot, nested), { recursive: true }),
    ]);
    const sourceAlias = join(sourceRoot, '..', 'source-alias');
    await symlink(sourceRoot, sourceAlias, 'dir');
    const launch = vi.fn(async () => ({ ok: true as const }));
    const expectedLaunchCwd = await realpath(join(worktreeRoot, nested));

    const result = await runJunctionCommand('--branch feature/test', join(sourceAlias, nested), {
      plan: async () => PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => WORKTREE,
      launch,
    });

    expect(result).toEqual({
      ok: true,
      status: 'created-and-launched',
      worktree: WORKTREE,
      launchCwd: expectedLaunchCwd,
    });
    expect(launch).toHaveBeenCalledWith(PLAN.branch, expectedLaunchCwd, expect.any(Object));
  });

  it.each(['missing', 'file'] as const)(
    'falls back to the worktree root when the relative destination is a %s',
    async (kind) => {
      const nested = join('packages', 'app');
      await mkdir(join(sourceRoot, nested), { recursive: true });
      if (kind === 'file') {
        await mkdir(join(worktreeRoot, 'packages'));
        await writeFile(join(worktreeRoot, nested), 'not a directory');
      }
      const launch = vi.fn(async () => ({ ok: true as const }));

      const result = await runJunctionCommand('--branch feature/test', join(sourceRoot, nested), {
        plan: async () => PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => WORKTREE,
        launch,
      });

      expect(result).toEqual({
        ok: true,
        status: 'created-and-launched',
        worktree: WORKTREE,
        launchCwd: worktreeRoot,
        launchCwdWarning: `Could not preserve "${nested}" because it is absent or unsafe in the target worktree; launched at the worktree root.`,
      });
      expect(launch).toHaveBeenCalledWith(PLAN.branch, worktreeRoot, expect.any(Object));
    },
  );

  it.each([
    ['in-tree', true],
    ['escaping', false],
  ] as const)(
    'accepts %s destination symlinks only when they remain contained',
    async (_case, safe) => {
      const nested = join('packages', 'app');
      await mkdir(join(sourceRoot, nested), { recursive: true });
      await mkdir(join(worktreeRoot, 'packages'));
      const target = safe ? join(worktreeRoot, 'shared') : join(sourceRoot, '..', 'outside');
      await mkdir(target);
      await symlink(target, join(worktreeRoot, nested), 'dir');
      const launch = vi.fn(async () => ({ ok: true as const }));

      const result = await runJunctionCommand('--branch feature/test', join(sourceRoot, nested), {
        plan: async () => PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => WORKTREE,
        launch,
      });

      const expectedLaunchCwd = safe ? await realpath(target) : worktreeRoot;
      expect(result).toMatchObject({ ok: true, launchCwd: expectedLaunchCwd });
      expect(launch).toHaveBeenCalledWith(PLAN.branch, expectedLaunchCwd, expect.any(Object));
    },
  );

  it.each(['--branch feature/test', 'checkout --branch feature/Keep-Case'])(
    'fails %s before mutation when cwd resolves outside the planned repository',
    async (args) => {
      const otherRoot = join(sourceRoot, '..', 'other-repository');
      await mkdir(otherRoot);
      const topLevel = await realpath(otherRoot);
      const preflight = vi.fn();
      const apply = vi.fn();
      const launch = vi.fn();

      const result = await runJunctionCommand(args, cwd, {
        plan: async () => ({
          ...PLAN,
          repository: { ...PLAN.repository, topLevel },
        }),
        planCheckout: async () => ({
          ...CHECKOUT_PLAN,
          repository: { ...CHECKOUT_PLAN.repository, topLevel },
        }),
        preflight,
        apply,
        launch,
      });

      expect(result).toEqual({
        ok: false,
        status: 'planning-failed',
        message: 'Current cwd resolves outside the repository; no worktree was created.',
      });
      expect(preflight).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

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
      runJunctionCommand('--branch feature/test', cwd, {
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
      'fork --branch feature/test --from HEAD',
      cwd,
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
      cwd,
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

  it.each([
    ['empty', ''],
    ['malformed', 'not json\n{"type":"session"}\n'],
    ['non-session', '{"type":"message"}\n{"type":"session"}\n'],
  ])('rejects a %s source before any orchestration', async (_case, contents) => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'invalid.jsonl');
    await writeFile(sourceSessionFile, contents);

    const plan = vi.fn(async () => PLAN);
    const preflight = vi.fn(async () => ({ ok: true as const }));
    const apply = vi.fn(async () => WORKTREE);
    const launch = vi.fn(async () => ({ ok: true as const }));

    const result = await runJunctionCommand(
      'fork --branch feature/test',
      cwd,
      { plan, preflight, apply, launch },
      {
        waitForIdle: async () => undefined,
        sessionManager: { getSessionFile: () => sourceSessionFile },
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'source-session-failed' });
    expect(plan).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('captures a readable absolute source and passes it as a fork recipe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'source;$(unsafe).jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');
    const nested = join('packages', 'forked');
    await Promise.all([
      mkdir(join(sourceRoot, nested), { recursive: true }),
      mkdir(join(worktreeRoot, nested), { recursive: true }),
    ]);
    const nestedCwd = join(sourceRoot, nested);
    const destinationCwd = await realpath(join(worktreeRoot, nested));

    const order: string[] = [];
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const waitForIdle = vi.fn(async () => {
      await idle;
      order.push('idle');
    });
    const getSessionFile = vi.fn(() => {
      order.push('session');
      return sourceSessionFile;
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

    const result = runJunctionCommand(
      'fork --branch feature/test --from refs/tags/source',
      nestedCwd,
      { plan, preflight, apply, launch },
      {
        waitForIdle,
        sessionManager: { getSessionFile },
      },
    );

    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(getSessionFile).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();

    resolveIdle();
    await expect(result).resolves.toMatchObject({ ok: true, status: 'created-and-launched' });

    expect(order).toEqual(['idle', 'session', 'plan', 'preflight', 'apply', 'launch']);
    expect(plan).toHaveBeenCalledWith(
      nestedCwd,
      'feature/test',
      expect.any(Object),
      'refs/tags/source',
    );
    expect(launch).toHaveBeenCalledWith(PLAN.branch, destinationCwd, expect.any(Object), {
      mode: 'fork',
      sourceSessionFile,
    });
    expect(process.env).toEqual(environmentBefore);
  });

  it('does not apply Git when cmux preflight fails', async () => {
    const apply = vi.fn();
    const launch = vi.fn();

    await expect(
      runJunctionCommand('--branch feature/test', cwd, {
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

  it('propagates checkout apply failures without launching or repairing state', async () => {
    const launch = vi.fn();
    const result = await runJunctionCommand('checkout --branch feature/Keep-Case', cwd, {
      planCheckout: async () => CHECKOUT_PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => ({
        ok: false,
        reason: 'prunable-worktree',
        message: 'Prunable worktree metadata requires manual inspection.',
      }),
      launch,
    });

    expect(result).toEqual({
      ok: false,
      status: 'worktree-failed',
      message: 'Prunable worktree metadata requires manual inspection.',
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('reports the attempted root when destination lookup and cmux launch fail', async () => {
    const nested = join('packages', 'app');
    await mkdir(join(sourceRoot, nested), { recursive: true });
    const launch = vi.fn(async () => ({
      ok: false as const,
      reason: 'launch-failed' as const,
      message: 'boom',
    }));
    const result = await runJunctionCommand('--branch feature/test', join(sourceRoot, nested), {
      plan: async () => PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => {
        await rm(worktreeRoot, { recursive: true });
        return WORKTREE;
      },
      launch,
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-failed',
      branch: 'feature/test',
      path: worktreeRoot,
      launchCwd: worktreeRoot,
      worktreeRetained: true,
      message: `Worktree retained after cmux launch failed: boom\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nRetry: /junction --branch feature/test`,
    });
    expect(launch).toHaveBeenCalledWith(PLAN.branch, worktreeRoot, expect.any(Object));
  });

  it('uses the exact checkout command after a definite fresh launch failure', async () => {
    const proof = vi.fn(async () => true);
    const result = await runJunctionCommand('checkout --branch feature/Keep-Case', cwd, {
      planCheckout: async () => CHECKOUT_PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => CHECKOUT_WORKTREE,
      launch: async () => ({ ok: false, reason: 'launch-failed', message: 'boom' }),
      proveRetained: proof,
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-failed',
      branch: CHECKOUT_WORKTREE.branch,
      path: worktreeRoot,
      launchCwd: worktreeRoot,
      worktreeRetained: true,
      message: `Worktree retained after cmux launch failed: boom\nBranch: feature/Keep-Case\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nRetry: /junction checkout --branch feature/Keep-Case`,
    });
    expect(proof).not.toHaveBeenCalled();
  });

  it('keeps an unknown checkout launch inspection-only without retained-state proof', async () => {
    const proof = vi.fn(async () => true);
    const result = await runJunctionCommand('checkout --branch feature/Keep-Case', cwd, {
      planCheckout: async () => CHECKOUT_PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => CHECKOUT_WORKTREE,
      launch: async () => ({ ok: false, reason: 'launch-unknown', message: 'timed out' }),
      proveRetained: proof,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial-launch-unknown',
      retrySafe: false,
    });
    if (result.ok) throw new Error('Expected cmux launch to be unknown.');
    expect(result.message).toContain('inspect cmux');
    expect(result.message).not.toContain('Retry:');
    expect(proof).not.toHaveBeenCalled();
  });

  it('preserves the fork command in retry guidance after a retained worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'source.jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');

    const result = await runJunctionCommand(
      'fork --branch feature/test',
      cwd,
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

  it('reports an explicit source and preserves mode in a proof-gated retry', async () => {
    const source = 'HEAD';
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const explicitPlan = {
      ...PLAN,
      kind: 'create-explicit' as const,
      baseRef: source,
      baseSha: sha,
    };
    const explicitWorktree = {
      ...WORKTREE,
      kind: 'create-explicit' as const,
      status: 'created' as const,
      baseRef: source,
      baseSha: sha,
    };
    const proof = vi.fn(async (plan: WorktreePlan) => {
      expect(plan).toBe(explicitPlan);
      return true;
    });

    const result = await runJunctionCommand('--branch feature/test --from HEAD', cwd, {
      plan: async () => explicitPlan,
      preflight: async () => ({ ok: true }),
      apply: async () => explicitWorktree,
      launch: async () => ({ ok: false, reason: 'launch-failed', message: 'cmux stopped' }),
      proveRetained: proof,
    });

    expect(result).toMatchObject({ ok: false, status: 'partial-launch-failed' });
    if (result.ok) throw new Error('Expected cmux launch to fail.');
    expect(result.message).toContain(`From: ${source} -> ${sha}`);
    expect(result.message).toContain('Retry: /junction --branch feature/test');
    expect(result.message).not.toContain('--from');
    expect(proof).toHaveBeenCalledWith(explicitPlan, expect.any(Object));
  });

  it('keeps explicit launch failures inspection-only when retained proof fails', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const explicitPlan = {
      ...PLAN,
      kind: 'create-explicit' as const,
      baseRef: 'HEAD',
      baseSha: sha,
    };
    const proof = vi.fn(async () => false);

    const result = await runJunctionCommand('--branch feature/test --from HEAD', cwd, {
      plan: async () => explicitPlan,
      preflight: async () => ({ ok: true }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      launch: async () => ({ ok: false, reason: 'launch-failed', message: 'cmux stopped' }),
      proveRetained: proof,
    });

    expect(result).toMatchObject({ ok: false, status: 'partial-launch-failed' });
    if (result.ok) throw new Error('Expected cmux launch to fail.');
    expect(result.message).toContain(`From: HEAD -> ${sha}`);
    expect(result.message).toContain('inspect Git state');
    expect(result.message).not.toContain('Retry:');
  });

  it('does not suggest an explicit retry when retained proof errors', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const result = await runJunctionCommand('--branch feature/test --from HEAD', cwd, {
      plan: async () => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      preflight: async () => ({ ok: true }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      launch: async () => ({ ok: false, reason: 'launch-failed', message: 'cmux stopped' }),
      proveRetained: async () => {
        throw new Error('proof unavailable');
      },
    });

    expect(result).toMatchObject({ ok: false, status: 'partial-launch-failed' });
    if (result.ok) throw new Error('Expected cmux launch to fail.');
    expect(result.message).toContain('inspect Git state');
    expect(result.message).not.toContain('Retry:');
  });

  it('keeps explicit unknown launch outcomes inspection-only without a proof call', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const proof = vi.fn(async () => true);
    const result = await runJunctionCommand('--branch feature/test --from HEAD', cwd, {
      plan: async () => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      preflight: async () => ({ ok: true }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      launch: async () => ({ ok: false, reason: 'launch-unknown', message: 'timed out' }),
      proveRetained: proof,
    });

    expect(result).toMatchObject({ ok: false, status: 'partial-launch-unknown' });
    if (result.ok) throw new Error('Expected cmux launch to be unknown.');
    expect(result.message).not.toContain('Retry:');
    expect(proof).not.toHaveBeenCalled();
  });

  it('maps an ambiguous real cmux launch without retry guidance', async () => {
    const runner: ProcessRunner = async () => ({
      outcome: 'timeout',
      timeoutMs: 10_000,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    });

    const result = await runJunctionCommand('--branch feature/test', cwd, {
      env: {},
      runner,
      plan: async () => PLAN,
      preflight: async () => ({ ok: true }),
      apply: async () => WORKTREE,
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-unknown',
      branch: PLAN.branch,
      path: worktreeRoot,
      launchCwd: worktreeRoot,
      worktreeRetained: true,
      retrySafe: false,
      message: `Worktree retained, but cmux launch status is unknown: command timed out; cmux workspace creation may have completed.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nThe workspace may exist; inspect cmux before taking further action.`,
    });
  });

  it('does not launch when worktree apply returns an unknown partial state', async () => {
    const launch = vi.fn();
    await expect(
      runJunctionCommand('--branch feature/test', cwd, {
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

  it('uses the repository-relative directory after worktree reuse', async () => {
    const nested = join('packages', 'reused');
    await Promise.all([
      mkdir(join(sourceRoot, nested), { recursive: true }),
      mkdir(join(worktreeRoot, nested), { recursive: true }),
    ]);
    const launch = vi.fn(async () => ({ ok: true as const }));
    const expectedLaunchCwd = await realpath(join(worktreeRoot, nested));

    await expect(
      runJunctionCommand('--branch feature/test', join(sourceRoot, nested), {
        plan: async () => PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => ({ ...WORKTREE, status: 'reused' }),
        launch,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'reused-and-launched',
      launchCwd: expectedLaunchCwd,
    });
    expect(launch).toHaveBeenCalledWith('feature/test', expectedLaunchCwd, expect.any(Object));
  });

  it.each(['', ' \t\n', 'help'])('shows help without orchestration (%j)', async (args) => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, options) => {
        handler = options.handler;
      }),
    };
    const notify = vi.fn();
    const waitForIdle = vi.fn(async () => undefined);
    const getSessionFile = vi.fn(() => undefined);
    const plan = vi.fn(async () => PLAN);
    const planCheckout = vi.fn(async () => CHECKOUT_PLAN);
    const preflight = vi.fn(async () => ({ ok: true as const }));
    const apply = vi.fn(async () => WORKTREE);
    const launch = vi.fn(async () => ({ ok: true as const }));

    registerJunctionCommand(pi, { plan, planCheckout, preflight, apply, launch });
    await handler?.(args, {
      cwd,
      ui: { notify },
      waitForIdle,
      sessionManager: { getSessionFile },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.any(String), 'info');
    const help = notify.mock.calls[0]?.[0];
    expect(help).toBe(
      [
        'Junction commands:',
        '  /junction [help] — show this command reference',
        '  /junction --branch <name> — create a new worktree from the default base or reuse a matching worktree; launch a fresh Pi session',
        '  /junction --branch <name> --from <commit-ish> — create a new worktree from the specified commit-ish (never reuse); launch a fresh Pi session',
        '  /junction fork --branch <name> — wait for the current persisted session to idle, then create a new worktree from the default base or reuse a matching worktree; fork the conversation',
        '  /junction fork --branch <name> --from <commit-ish> — wait for the current persisted session to idle, then create a new worktree from the specified commit-ish (never reuse); fork the conversation',
        '  /junction checkout --branch <local-branch> — open an existing local branch in its worktree; launch a fresh Pi session',
      ].join('\n'),
    );
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(getSessionFile).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(planCheckout).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['created', 'reused'] as const)(
    'notifies checkout %s without a create source',
    async (status) => {
      let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((_name, options) => {
          handler = options.handler;
        }),
      };
      const notify = vi.fn();

      registerJunctionCommand(pi, {
        planCheckout: async () => CHECKOUT_PLAN,
        preflight: async () => ({ ok: true }),
        apply: async () => ({ ...CHECKOUT_WORKTREE, status }),
        launch: async () => ({ ok: true }),
      });
      await handler?.('checkout --branch feature/Keep-Case', {
        cwd,
        ui: { notify },
      } as unknown as ExtensionCommandContext);

      const verb = status === 'created' ? 'Created' : 'Reused';
      expect(notify).toHaveBeenCalledWith(
        `${verb} worktree and launched cmux workspace.\nBranch: feature/Keep-Case\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}`,
        'info',
      );
      expect(notify.mock.calls[0]?.[0]).not.toContain('From:');
    },
  );

  it('notifies the pinned source for an explicit create', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, options) => {
        handler = options.handler;
      }),
    };
    const notify = vi.fn();

    registerJunctionCommand(pi, {
      plan: async () => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      preflight: async () => ({ ok: true }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      launch: async () => ({ ok: true }),
    });
    await handler?.('--branch feature/test --from HEAD', {
      cwd,
      ui: { notify },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      `Created worktree and launched cmux workspace.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nFrom: HEAD -> ${sha}`,
      'info',
    );
  });

  it('notifies a successful root fallback without replacing the base warning', async () => {
    const nested = join('packages', 'missing');
    await mkdir(join(sourceRoot, nested), { recursive: true });
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
      apply: async () => ({ ...WORKTREE, warning: 'Base reference changed during apply.' }),
      launch: async () => ({ ok: true }),
    });
    await handler?.('--branch feature/test', {
      cwd: join(sourceRoot, nested),
      ui: { notify },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      `Created worktree and launched cmux workspace.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nWarning: Base reference changed during apply.\nWarning: Could not preserve "${nested}" because it is absent or unsafe in the target worktree; launched at the worktree root.`,
      'info',
    );
  });
});
