import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../extensions/session-deck/worktree/launch.js', () => ({
  preflightDetachedTmuxPi: vi.fn(),
  launchDetachedTmuxPiForCwd: vi.fn(),
}));
vi.mock('../../extensions/session-deck/worktree/repo-intent.js', () => ({
  resolveRepoIntent: vi.fn(),
}));
vi.mock('../../extensions/session-deck/worktree/create.js', () => ({
  planGitWorktree: vi.fn(),
  applyGitWorktreePlan: vi.fn(),
}));
vi.mock('../../extensions/session-deck/worktree/git.js', () => ({
  defaultWorktreePath: vi.fn(),
  execGit: vi.fn(),
}));

import { orchestrateCreateSession } from '../../extensions/session-deck/session/create.js';
import {
  launchDetachedTmuxPiForCwd,
  preflightDetachedTmuxPi,
} from '../../extensions/session-deck/worktree/launch.js';
import { resolveRepoIntent } from '../../extensions/session-deck/worktree/repo-intent.js';
import {
  applyGitWorktreePlan,
  planGitWorktree,
} from '../../extensions/session-deck/worktree/create.js';
import { defaultWorktreePath, execGit } from '../../extensions/session-deck/worktree/git.js';

const mockedPreflightDetachedTmuxPi = vi.mocked(preflightDetachedTmuxPi);
const mockedLaunchDetachedTmuxPiForCwd = vi.mocked(launchDetachedTmuxPiForCwd);
const mockedResolveRepoIntent = vi.mocked(resolveRepoIntent);
const mockedPlanGitWorktree = vi.mocked(planGitWorktree);
const mockedApplyGitWorktreePlan = vi.mocked(applyGitWorktreePlan);
const mockedDefaultWorktreePath = vi.mocked(defaultWorktreePath);
const mockedExecGit = vi.mocked(execGit);

const DIRECTORY_STAT = { isDirectory: () => true };

beforeEach(() => {
  vi.clearAllMocks();
  mockedPreflightDetachedTmuxPi.mockResolvedValue({ ok: true });
  mockedLaunchDetachedTmuxPiForCwd.mockResolvedValue({
    requested: true,
    ok: true,
    mode: 'tmux-detached',
    status: 'launched',
    tmuxSessionName: 'pi-scratch-scratch-1234',
    tmuxTarget: '=pi-scratch-scratch-1234',
    message: 'Started a detached tmux Pi session.',
    manualAttachCommand: 'tmux attach-session -t =pi-scratch-scratch-1234',
  });
});

describe('session-deck create-session orchestration', () => {
  it('launches a valid cwd and never touches repo or git worktree helpers', async () => {
    const stat = vi.fn(async () => DIRECTORY_STAT);

    await expect(
      orchestrateCreateSession(
        {
          action: 'create-session',
          cwd: '~/scratch',
          launch: {
            mode: 'tmux-detached',
            agentDir: { mode: 'custom', customDir: '~/agent-work' },
          },
        },
        { homeDir: '/Users/test', stat, postLaunchVerifyDelayMs: 0 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 'launched',
      cwd: '/Users/test/scratch',
      launch: { requested: true, ok: true, status: 'launched' },
    });

    expect(stat).toHaveBeenCalledWith('/Users/test/scratch');
    expect(mockedPreflightDetachedTmuxPi).toHaveBeenCalledWith(
      expect.objectContaining({
        postLaunchVerifyDelayMs: 0,
        agentDir: { mode: 'custom', customDir: '/Users/test/agent-work' },
      }),
    );
    expect(mockedLaunchDetachedTmuxPiForCwd).toHaveBeenCalledWith(
      { cwd: '/Users/test/scratch', repoName: null },
      'scratch',
      expect.objectContaining({
        postLaunchVerifyDelayMs: 0,
        agentDir: { mode: 'custom', customDir: '/Users/test/agent-work' },
      }),
    );
    expect(mockedResolveRepoIntent).not.toHaveBeenCalled();
    expect(mockedPlanGitWorktree).not.toHaveBeenCalled();
    expect(mockedApplyGitWorktreePlan).not.toHaveBeenCalled();
    expect(mockedDefaultWorktreePath).not.toHaveBeenCalled();
    expect(mockedExecGit).not.toHaveBeenCalled();
  });

  it('returns validation failure for invalid cwd before preflight', async () => {
    const stat = vi.fn(async () => DIRECTORY_STAT);

    await expect(
      orchestrateCreateSession({ action: 'create-session', cwd: 'relative/path' }, { stat }),
    ).resolves.toEqual({
      ok: false,
      status: 'failed',
      failurePhase: 'validation',
      reason: 'invalid-cwd',
      message: 'Working directory must be absolute, ~, or start with ~/.',
      recoverable: true,
    });

    expect(stat).not.toHaveBeenCalled();
    expect(mockedPreflightDetachedTmuxPi).not.toHaveBeenCalled();
    expect(mockedLaunchDetachedTmuxPiForCwd).not.toHaveBeenCalled();
  });

  it('returns cwd-not-found and cwd-not-directory validation failures', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

    await expect(
      orchestrateCreateSession(
        { action: 'create-session', cwd: '/tmp/missing' },
        { stat: vi.fn(async () => Promise.reject(missing)) },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      failurePhase: 'validation',
      reason: 'cwd-not-found',
    });

    await expect(
      orchestrateCreateSession(
        { action: 'create-session', cwd: '/tmp/file' },
        { stat: vi.fn(async () => ({ isDirectory: () => false })) },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      failurePhase: 'validation',
      reason: 'cwd-not-directory',
    });

    expect(mockedPreflightDetachedTmuxPi).not.toHaveBeenCalled();
    expect(mockedLaunchDetachedTmuxPiForCwd).not.toHaveBeenCalled();
  });

  it('returns session-specific preflight failure before launch', async () => {
    mockedPreflightDetachedTmuxPi.mockResolvedValueOnce({
      ok: false,
      reason: 'tmux-unavailable',
    });

    await expect(
      orchestrateCreateSession(
        { action: 'create-session', cwd: '/tmp/scratch' },
        { stat: vi.fn(async () => DIRECTORY_STAT) },
      ),
    ).resolves.toEqual({
      ok: false,
      status: 'preflight-failed',
      failurePhase: 'preflight',
      preflight: {
        reason: 'tmux-unavailable',
        recoverable: true,
        message: 'New Pi session requires tmux on PATH; no session was launched.',
      },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    });

    expect(mockedLaunchDetachedTmuxPiForCwd).not.toHaveBeenCalled();
  });

  it('returns launch-failed with the normalized cwd', async () => {
    mockedLaunchDetachedTmuxPiForCwd.mockResolvedValueOnce({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'spawn-failed',
      recoverable: true,
      message: 'tmux could not start Pi.',
      manualCommand: 'cd /tmp/scratch && pi',
    });

    await expect(
      orchestrateCreateSession(
        { action: 'create-session', cwd: '/tmp/scratch/../scratch' },
        { stat: vi.fn(async () => DIRECTORY_STAT) },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'launch-failed',
      failurePhase: 'launch',
      cwd: '/tmp/scratch',
      launch: { requested: true, ok: false, reason: 'spawn-failed' },
    });
  });

  it('returns reused-existing when tmux launch reuses the cwd session', async () => {
    mockedLaunchDetachedTmuxPiForCwd.mockResolvedValueOnce({
      requested: true,
      ok: true,
      mode: 'tmux-detached',
      status: 'reused-existing',
      tmuxSessionName: 'pi-scratch-scratch-1234',
      tmuxTarget: '=pi-scratch-scratch-1234',
      message: 'Reused an existing detached tmux Pi session.',
      manualAttachCommand: 'tmux attach-session -t =pi-scratch-scratch-1234',
    });

    await expect(
      orchestrateCreateSession(
        { action: 'create-session', cwd: '/tmp/scratch' },
        { stat: vi.fn(async () => DIRECTORY_STAT) },
      ),
    ).resolves.toMatchObject({
      ok: true,
      status: 'reused-existing',
      cwd: '/tmp/scratch',
      launch: { requested: true, ok: true, status: 'reused-existing' },
    });
  });
});
