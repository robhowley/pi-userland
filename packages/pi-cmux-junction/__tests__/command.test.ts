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
import type { CmuxTabCaller } from '../extensions/cmux-junction/cmux.js';
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

const TAB_CALLER: CmuxTabCaller = {
  socketPath: '/tmp/cmux.sock',
  windowId: '11111111-1111-1111-1111-111111111111',
  workspaceId: '22222222-2222-2222-2222-222222222222',
  paneId: '33333333-3333-3333-3333-333333333333',
  surfaceId: '44444444-4444-4444-4444-444444444444',
};
const MOVED_TAB_CALLER: CmuxTabCaller = {
  ...TAB_CALLER,
  workspaceId: '55555555-5555-5555-5555-555555555555',
  paneId: '66666666-6666-6666-6666-666666666666',
};

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
  it.each(['board install', '  board   install \t\n'])('parses only board install: %j', (args) => {
    expect(parseJunctionArgs(args)).toEqual({ ok: true, mode: 'board-install' });
  });
  it.each([
    'board',
    'board update',
    'board install extra',
    'board install --tab',
    'board install /tmp/x',
    'board fork --branch x',
    'board install --from HEAD',
  ])('rejects board arguments: %s', async (args) => {
    const installBoard = vi.fn();
    expect(await runJunctionCommand(args, cwd, { installBoard })).toEqual({
      ok: false,
      status: 'invalid-command',
      message: 'Usage: /junction board install',
    });
    expect(installBoard).not.toHaveBeenCalled();
  });
  it('offers full-prefix board completion through the registered callback', () => {
    const registerCommand = vi.fn();
    registerJunctionCommand({ registerCommand });
    const complete = registerCommand.mock.calls[0]?.[1].getArgumentCompletions;
    for (const prefix of ['b', 'bo', 'board'])
      expect(complete(prefix)).toEqual([expect.objectContaining({ value: 'board' })]);
    for (const prefix of ['board ', 'board i', '  board   i'])
      expect(complete(prefix)).toEqual([
        expect.objectContaining({ value: 'board install', label: 'install' }),
      ]);
    for (const prefix of ['board install ', 'board update', 'board i extra', 'board --tab'])
      expect(complete(prefix)).toBeNull();
  });
  it('installs in a temporary home before any repository, cmux or session operation', async () => {
    const forbidden = vi.fn(() => {
      throw new Error('must not run');
    });
    const result = await runJunctionCommand(
      'board install',
      join(cwd, 'nonexistent'),
      {
        homeDir: sourceRoot,
        runner: forbidden,
        plan: forbidden,
        planCheckout: forbidden,
        preflight: forbidden,
        preflightTab: forbidden,
        apply: forbidden,
        launch: forbidden,
        launchTab: forbidden,
      },
      { waitForIdle: forbidden, sessionManager: { getSessionFile: forbidden } },
    );
    expect(result).toEqual({
      ok: true,
      status: 'board-installed',
      path: join(sourceRoot, '.config/cmux/sidebars/junction-board.swift'),
    });
    expect(forbidden).not.toHaveBeenCalled();
  });
  it.each([
    { ok: true, status: 'board-installed', path: '/test/board', text: 'Installed' },
    { ok: true, status: 'board-updated', path: '/test/board', text: 'Updated' },
    {
      ok: true,
      status: 'board-current',
      path: '/test/board',
      warning: 'unowned',
      text: 'Already current',
    },
    {
      ok: false,
      status: 'board-install-failed',
      path: '/test/board',
      message: 'failure',
      text: 'failure',
    },
    {
      ok: false,
      status: 'board-install-partial',
      path: '/test/board',
      message: 'partial',
      text: 'partial',
    },
  ] as const)(
    'notifies board outcome $status and forwards only homeDir',
    async ({ text, ...result }) => {
      const registerCommand = vi.fn();
      const installBoard = vi.fn(async () => result);
      registerJunctionCommand(
        { registerCommand },
        { installBoard, homeDir: sourceRoot, env: { X: 'ignored' }, timeoutMs: 1 },
      );
      const notify = vi.fn();
      await registerCommand.mock.calls[0]?.[1].handler('board install', { cwd, ui: { notify } });
      expect(installBoard).toHaveBeenCalledWith({ homeDir: sourceRoot });
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(text),
        result.ok ? 'info' : 'error',
      );
      if (result.ok) expect(notify.mock.calls[0]?.[0]).toContain(result.path);
      if ('warning' in result) expect(notify.mock.calls[0]?.[0]).toContain('unowned');
    },
  );
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
      expect.objectContaining({ value: 'board' }),
    ]);
    expect(getJunctionArgumentCompletions('c')).toEqual([checkout]);
    expect(getJunctionArgumentCompletions('checkout ')).toEqual([branch]);
    expect(getJunctionArgumentCompletions('checkout --b')).toEqual([branch]);
    for (const input of [
      'checkout --branch ',
      'checkout --branch feature/test',
      'checkout --branch feature/test --f',
      'checkout --branch feature/test --from ',
      'checkout --branch feature/test --tab extra',
      'checkout --branch refs/foo',
      'checkout unknown',
      'checkout fork --branch feature/test',
    ]) {
      expect(getJunctionArgumentCompletions(input)).toBeNull();
    }
  });

  it('offers --from and --tab only after complete values', () => {
    const from = {
      value: '--from',
      label: '--from',
      description: 'Create from a committed Git ref; working-tree changes are not copied',
    };
    const tab = {
      value: '--tab',
      label: '--tab',
      description: 'Launch Pi in a new unfocused tab in this workspace',
    };
    const head = {
      value: 'HEAD',
      label: 'HEAD',
      description:
        'Current committed commit; staged, unstaged, untracked, and ignored changes are not copied',
    };

    expect(getJunctionArgumentCompletions('--branch feature/test ')).toEqual([from, tab]);
    expect(getJunctionArgumentCompletions('fork --branch feature/test ')).toEqual([from, tab]);
    expect(getJunctionArgumentCompletions('checkout --branch feature/test ')).toEqual([tab]);
    expect(getJunctionArgumentCompletions('--branch feature/test --f')).toEqual([from]);
    expect(getJunctionArgumentCompletions('--branch feature/test --t')).toEqual([tab]);
    expect(getJunctionArgumentCompletions('--branch feature/test --tab')).toEqual([tab]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from ')).toEqual([head]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from H')).toEqual([head]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from HEAD ')).toEqual([tab]);
    expect(getJunctionArgumentCompletions('--branch feature/test --from refs/heads/main ')).toEqual(
      [tab],
    );
    expect(getJunctionArgumentCompletions('--branch feature/test --from HEAD --t')).toEqual([tab]);
    expect(getJunctionArgumentCompletions('--branch --from ')).toBeNull();
    expect(getJunctionArgumentCompletions('--branch feature/test --tab ')).toBeNull();
    expect(getJunctionArgumentCompletions('--branch feature/test --tab extra')).toBeNull();
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

  it.each([
    ['--branch feature/fresh --tab', { mode: 'fresh', branch: 'feature/fresh', tab: true }],
    [
      '--branch feature/fresh --from refs/tags/source --tab',
      { mode: 'fresh', branch: 'feature/fresh', from: 'refs/tags/source', tab: true },
    ],
    ['fork --branch feature/forked --tab', { mode: 'fork', branch: 'feature/forked', tab: true }],
    [
      'fork --branch feature/forked --from HEAD --tab',
      { mode: 'fork', branch: 'feature/forked', from: 'HEAD', tab: true },
    ],
    [
      'checkout --branch Feature/Keep-Case --tab',
      { mode: 'checkout', branch: 'Feature/Keep-Case', tab: true },
    ],
  ] as const)('parses the strict trailing --tab form: %s', (args, expected) => {
    expect(parseJunctionArgs(args)).toEqual({ ok: true, ...expected });
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
    'checkout --branch feature/test --tab extra',
    'checkout --branch feature/test --tab --tab',
    'checkout --branch feature/test --tab=now',
    'checkout --branch feature/test --tab --from HEAD',
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
    '--branch --tab feature/test',
    '--tab --branch feature/test',
    '--branch feature/test --tab extra',
    '--branch feature/test --tab --tab',
    '--branch feature/test --tab=now',
    '--branch feature/test --tab --from HEAD',
    '--branch feature/test --from HEAD --tab extra',
    '--branch feature/test --from HEAD --tab --tab',
    '--branch feature/test --from HEAD --tab=now',
    'fork --from HEAD --branch feature/test',
    'fork --branch feature/test --tab extra',
    'fork --branch feature/test --tab --tab',
    'fork --branch feature/test --tab=now',
    'fork --branch feature/test --tab --from HEAD',
    'fork --branch feature/test --from HEAD --tab extra',
    'fork --branch feature/test --from HEAD --tab --tab',
    'fork --branch feature/test --from HEAD --tab=now',
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

  it.each([
    ['fresh workspace', '--branch feature/test', false, false, false],
    ['fresh tab', '--branch feature/test --tab', true, false, false],
    ['fork workspace', 'fork --branch feature/test', false, false, true],
    ['fork tab', 'fork --branch feature/test --tab', true, false, true],
    ['checkout workspace', 'checkout --branch feature/Keep-Case', false, true, false],
    ['checkout tab', 'checkout --branch feature/Keep-Case --tab', true, true, false],
  ] as const)(
    'selects only the %s preflight and launcher',
    async (_case, args, tab, checkout, fork) => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
      tempDirectories.push(directory);
      const sourceSessionFile = join(directory, 'source.jsonl');
      await writeFile(sourceSessionFile, '{"type":"session"}\n');

      const preflight = vi.fn(async () => ({ ok: true as const }));
      const preflightTab = vi.fn(async () => ({ ok: true as const, caller: TAB_CALLER }));
      const launch = vi.fn(async () => ({ ok: true as const }));
      const launchTab = vi.fn(async () => ({
        ok: true as const,
        mutation: 'exists' as const,
        surfaceRef: 'surface:115',
        target: MOVED_TAB_CALLER,
      }));
      const worktree = checkout ? CHECKOUT_WORKTREE : WORKTREE;
      const result = await runJunctionCommand(
        args,
        cwd,
        {
          plan: async () => PLAN,
          planCheckout: async () => CHECKOUT_PLAN,
          preflight,
          preflightTab,
          apply: async () => worktree,
          launch,
          launchTab,
        },
        fork
          ? {
              waitForIdle: async () => undefined,
              sessionManager: { getSessionFile: () => sourceSessionFile },
            }
          : undefined,
      );

      expect(result).toEqual({
        ok: true,
        status: 'created-and-launched',
        worktree,
        launchCwd: worktreeRoot,
        ...(tab ? { tab: { surfaceRef: 'surface:115' } } : {}),
      });
      expect(preflight).toHaveBeenCalledTimes(tab ? 0 : 1);
      expect(preflightTab).toHaveBeenCalledTimes(tab ? 1 : 0);
      expect(launch).toHaveBeenCalledTimes(tab ? 0 : 1);
      expect(launchTab).toHaveBeenCalledTimes(tab ? 1 : 0);

      const recipe = fork
        ? { mode: 'fork' as const, sourceSessionFile }
        : { mode: 'fresh' as const };
      if (tab) {
        expect(launchTab).toHaveBeenCalledWith(
          worktreeRoot,
          TAB_CALLER,
          expect.any(Object),
          recipe,
        );
      } else if (fork) {
        expect(launch).toHaveBeenCalledWith(
          worktree.branch,
          worktreeRoot,
          expect.any(Object),
          recipe,
        );
      } else {
        expect(launch).toHaveBeenCalledWith(worktree.branch, worktreeRoot, expect.any(Object));
      }
    },
  );

  it('orders fork capture, planning, tab preflight, apply, and tab launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'source.jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');
    const order: string[] = [];
    const launchTab = vi.fn(async () => {
      order.push('tab-launch');
      return {
        ok: true as const,
        mutation: 'exists' as const,
        surfaceRef: 'surface:115',
        target: MOVED_TAB_CALLER,
      };
    });

    await expect(
      runJunctionCommand(
        'fork --branch feature/test --from HEAD --tab',
        cwd,
        {
          plan: async () => {
            order.push('plan');
            return PLAN;
          },
          preflight: async () => {
            throw new Error('workspace preflight must not run');
          },
          preflightTab: async () => {
            order.push('tab-preflight');
            return { ok: true, caller: TAB_CALLER };
          },
          apply: async () => {
            order.push('apply');
            return WORKTREE;
          },
          launch: async () => {
            throw new Error('workspace launch must not run');
          },
          launchTab,
        },
        {
          waitForIdle: async () => {
            order.push('idle');
          },
          sessionManager: {
            getSessionFile: () => {
              order.push('session');
              return sourceSessionFile;
            },
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true, tab: { surfaceRef: 'surface:115' } });

    expect(order).toEqual(['idle', 'session', 'plan', 'tab-preflight', 'apply', 'tab-launch']);
    expect(launchTab).toHaveBeenCalledWith(worktreeRoot, TAB_CALLER, expect.any(Object), {
      mode: 'fork',
      sourceSessionFile,
    });
  });

  it('does not apply Git when tab preflight fails', async () => {
    const preflight = vi.fn();
    const apply = vi.fn();
    const launch = vi.fn();
    const launchTab = vi.fn();

    await expect(
      runJunctionCommand('--branch feature/test --tab', cwd, {
        plan: async () => PLAN,
        preflight,
        preflightTab: async () => ({
          ok: false,
          reason: 'caller-unavailable',
          message: 'The invoking cmux terminal could not be identified; no worktree was created.',
        }),
        apply,
        launch,
        launchTab,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 'preflight-failed',
      message: 'The invoking cmux terminal could not be identified; no worktree was created.',
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(launchTab).not.toHaveBeenCalled();
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

  it('retains the worktree and preserves --tab in a safe retry when creation did not start', async () => {
    const result = await runJunctionCommand('--branch feature/test --tab', cwd, {
      plan: async () => PLAN,
      preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
      apply: async () => WORKTREE,
      launchTab: async () => ({
        ok: false,
        mutation: 'none',
        reason: 'create-not-started',
        message: 'cmux tab creation could not start.',
      }),
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-failed',
      branch: PLAN.branch,
      path: worktreeRoot,
      launchCwd: worktreeRoot,
      worktreeRetained: true,
      tab: { mutation: 'none' },
      message: `Worktree retained after cmux tab launch failed before creation: cmux tab creation could not start.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nNo tab was created or launch command submitted.\nRetry: /junction --branch feature/test --tab`,
    });
  });

  it('preserves checkout mode and final --tab in a safe retry', async () => {
    const result = await runJunctionCommand('checkout --branch feature/Keep-Case --tab', cwd, {
      planCheckout: async () => CHECKOUT_PLAN,
      preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
      apply: async () => CHECKOUT_WORKTREE,
      launchTab: async () => ({
        ok: false,
        mutation: 'none',
        reason: 'caller-unavailable',
        message: 'The caller moved.',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial-launch-failed',
      worktreeRetained: true,
      tab: { mutation: 'none' },
    });
    if (result.ok) throw new Error('Expected tab launch to fail.');
    expect(result.message).toContain('Retry: /junction checkout --branch feature/Keep-Case --tab');
  });

  it('drops --from but preserves fork mode and final --tab in a proof-gated retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-cmux-junction-session-'));
    tempDirectories.push(directory);
    const sourceSessionFile = join(directory, 'source.jsonl');
    await writeFile(sourceSessionFile, '{"type":"session"}\n');
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const explicitPlan = {
      ...PLAN,
      kind: 'create-explicit' as const,
      baseRef: 'HEAD',
      baseSha: sha,
    };
    const proof = vi.fn(async () => true);

    const result = await runJunctionCommand(
      'fork --branch feature/test --from HEAD --tab',
      cwd,
      {
        plan: async () => explicitPlan,
        preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
        apply: async () => ({
          ...WORKTREE,
          kind: 'create-explicit' as const,
          status: 'created' as const,
          baseRef: 'HEAD',
          baseSha: sha,
        }),
        launchTab: async () => ({
          ok: false,
          mutation: 'none',
          reason: 'caller-unavailable',
          message: 'The caller moved.',
        }),
        proveRetained: proof,
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
      tab: { mutation: 'none' },
    });
    if (result.ok) throw new Error('Expected tab launch to fail.');
    expect(result.message).toContain(`From: HEAD -> ${sha}`);
    expect(result.message).toContain('Retry: /junction fork --branch feature/test --tab');
    expect(result.message).not.toContain('Retry: /junction fork --branch feature/test --from');
    expect(proof).toHaveBeenCalledWith(explicitPlan, expect.any(Object));
  });

  it('withholds a tab retry when explicit retained-state proof fails', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const proof = vi.fn(async () => false);
    const result = await runJunctionCommand('--branch feature/test --from HEAD --tab', cwd, {
      plan: async () => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: sha,
      }),
      launchTab: async () => ({
        ok: false,
        mutation: 'none',
        reason: 'staging-failed',
        message: 'The private tab launch script could not be staged.',
      }),
      proveRetained: proof,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial-launch-failed',
      worktreeRetained: true,
      tab: { mutation: 'none' },
    });
    if (result.ok) throw new Error('Expected tab launch to fail.');
    expect(result.message).toContain('No tab was created or launch command submitted.');
    expect(result.message).toContain('inspect Git state');
    expect(result.message).not.toContain('Retry:');
    expect(proof).toHaveBeenCalledOnce();
  });

  it('reports unknown tab creation ancestry without retry, cleanup, or retained proof', async () => {
    const proof = vi.fn(async () => true);
    const result = await runJunctionCommand('--branch feature/test --from HEAD --tab', cwd, {
      plan: async () => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: 'HEAD',
        baseSha: '0123456789abcdef0123456789abcdef01234567',
      }),
      preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: '0123456789abcdef0123456789abcdef01234567',
      }),
      launchTab: async () => ({
        ok: false,
        mutation: 'may-exist',
        reason: 'create-unknown',
        target: MOVED_TAB_CALLER,
        message: 'cmux tab creation may have completed.',
      }),
      proveRetained: proof,
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-unknown',
      branch: PLAN.branch,
      path: worktreeRoot,
      launchCwd: worktreeRoot,
      worktreeRetained: true,
      retrySafe: false,
      tab: { mutation: 'may-exist' },
      message: `Worktree retained, but cmux tab creation is unknown: cmux tab creation may have completed.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nTarget: window ${MOVED_TAB_CALLER.windowId}, workspace ${MOVED_TAB_CALLER.workspaceId}, pane ${MOVED_TAB_CALLER.paneId}.\nNo automatic retry or cleanup was attempted.`,
    });
    expect(proof).not.toHaveBeenCalled();
  });

  it('reports the exact created tab and possible blank launch without retry or cleanup', async () => {
    const proof = vi.fn(async () => true);
    const result = await runJunctionCommand('--branch feature/test --from HEAD --tab', cwd, {
      plan: async () => ({
        ...PLAN,
        kind: 'create-explicit' as const,
        baseRef: 'HEAD',
        baseSha: '0123456789abcdef0123456789abcdef01234567',
      }),
      preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
      apply: async () => ({
        ...WORKTREE,
        kind: 'create-explicit' as const,
        status: 'created' as const,
        baseRef: 'HEAD',
        baseSha: '0123456789abcdef0123456789abcdef01234567',
      }),
      launchTab: async () => ({
        ok: false,
        mutation: 'exists',
        reason: 'send-failed',
        surfaceRef: 'surface:115',
        target: MOVED_TAB_CALLER,
        message: 'cmux created surface:115, but Pi launch submission failed.',
      }),
      proveRetained: proof,
    });

    expect(result).toEqual({
      ok: false,
      status: 'partial-launch-failed',
      branch: PLAN.branch,
      path: worktreeRoot,
      launchCwd: worktreeRoot,
      worktreeRetained: true,
      retrySafe: false,
      tab: { mutation: 'exists', surfaceRef: 'surface:115' },
      message: `Worktree retained after Pi launch submission failed for cmux tab surface:115: cmux created surface:115, but Pi launch submission failed.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}\nThe tab may be blank or partially launched. No automatic retry or cleanup was attempted.`,
    });
    expect(proof).not.toHaveBeenCalled();
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
    let description = '';
    const pi = {
      registerCommand: vi.fn((_name, options) => {
        handler = options.handler;
        description = options.description;
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

    const installBoard = vi.fn();
    registerJunctionCommand(pi, { plan, planCheckout, preflight, apply, launch, installBoard });
    await handler?.(args, {
      cwd,
      ui: { notify },
      waitForIdle,
      sessionManager: { getSessionFile },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.any(String), 'info');
    expect(installBoard).not.toHaveBeenCalled();
    expect(description).toContain('--tab');
    const help = notify.mock.calls[0]?.[0];
    expect(help).toBe(
      [
        'Junction commands:',
        '  /junction [help] — show this command reference',
        '  /junction --branch <name> [--tab] — create a new worktree from the default base or reuse a matching worktree; launch a fresh Pi session',
        '  /junction --branch <name> --from <commit-ish> [--tab] — create a new worktree from the specified commit-ish (never reuse); launch a fresh Pi session',
        '  /junction fork --branch <name> [--tab] — wait for the current persisted session to idle, then create a new worktree from the default base or reuse a matching worktree; fork the conversation',
        '  /junction fork --branch <name> --from <commit-ish> [--tab] — wait for the current persisted session to idle, then create a new worktree from the specified commit-ish (never reuse); fork the conversation',
        '  /junction checkout --branch <local-branch> [--tab] — open an existing local branch in its worktree; launch a fresh Pi session',
        '  /junction board install — install or safely update the packaged sidebar file; does not select it or enable publication',
        '  For worktree commands, append `--tab` to launch Pi in a new unfocused tab in this workspace instead of a new cmux workspace.',
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

  it('reports tab command acceptance without claiming Pi startup or parent lifecycle registration', async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, options) => {
        handler = options.handler;
      }),
    };
    const notify = vi.fn();
    const registerLifecycle = vi.fn();

    registerJunctionCommand(pi, {
      plan: async () => PLAN,
      preflightTab: async () => ({ ok: true, caller: TAB_CALLER }),
      apply: async () => WORKTREE,
      launchTab: async () => ({
        ok: true,
        mutation: 'exists',
        surfaceRef: 'surface:115',
        target: MOVED_TAB_CALLER,
      }),
    });
    await handler?.('--branch feature/test --tab', {
      cwd,
      ui: { notify },
      registerLifecycle,
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      `Created worktree and cmux accepted one Pi launch command for tab surface:115; Pi startup is not confirmed.\nBranch: feature/test\nPath: ${worktreeRoot}\nLaunch cwd: ${worktreeRoot}`,
      'info',
    );
    expect(registerLifecycle).not.toHaveBeenCalled();
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
