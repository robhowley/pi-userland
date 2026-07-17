import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../extensions/session-deck/worktree/repo-intent.js', () => ({
  resolveRepoIntent: vi.fn(),
}));
vi.mock('../../extensions/session-deck/worktree/create.js', () => ({
  planGitWorktree: vi.fn(),
  applyGitWorktreePlan: vi.fn(),
}));
vi.mock('../../extensions/session-deck/worktree/launch.js', () => ({
  preflightDetachedTmuxPi: vi.fn(),
  launchDetachedTmuxPi: vi.fn(),
}));

import {
  applyGitWorktreePlan,
  planGitWorktree,
} from '../../extensions/session-deck/worktree/create.js';
import {
  launchDetachedTmuxPi,
  preflightDetachedTmuxPi,
} from '../../extensions/session-deck/worktree/launch.js';
import { resolveRepoIntent } from '../../extensions/session-deck/worktree/repo-intent.js';
import { orchestrateCreateWorktree } from '../../extensions/session-deck/worktree/orchestrate.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreeResolvedRepo,
} from '../../extensions/session-deck/worktree/types.js';

const mockedResolveRepoIntent = vi.mocked(resolveRepoIntent);
const mockedPlanGitWorktree = vi.mocked(planGitWorktree);
const mockedApplyGitWorktreePlan = vi.mocked(applyGitWorktreePlan);
const mockedPreflightDetachedTmuxPi = vi.mocked(preflightDetachedTmuxPi);
const mockedLaunchDetachedTmuxPi = vi.mocked(launchDetachedTmuxPi);

const REPO: CreateWorktreeResolvedRepo = {
  repoName: 'project',
  qualifiedRepoName: 'owner/project',
  primaryWorktreePath: '/tmp/project',
  commonGitDir: '/tmp/project/.git',
  candidateRuntimeIds: ['rt-1'],
};

const REQUEST: CreateWorktreeActionRequest = {
  repoIntent: {
    repoName: 'project',
    qualifiedRepoName: 'owner/project',
    candidateRuntimeIds: ['rt-1'],
  },
  branchName: 'feature/test',
  baseRef: 'origin/main',
  launch: { mode: 'tmux-detached' },
};

const PLANNED_CREATE = {
  ok: true as const,
  action: 'create' as const,
  path: '/tmp/project-wt-feature-test',
  branch: 'feature/test',
  baseRef: 'origin/main',
  baseSha: 'abc123',
  repoName: 'project',
  qualifiedRepoName: 'owner/project',
  manualCommand: 'git worktree add ...',
};

const CREATED_WORKTREE = {
  ok: true as const,
  status: 'created' as const,
  path: '/tmp/project-wt-feature-test',
  branch: 'feature/test',
  baseRef: 'origin/main',
  repoName: 'project',
  qualifiedRepoName: 'owner/project',
  manualCommand: 'git worktree add ...',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveRepoIntent.mockResolvedValue({ ok: true, repo: REPO });
  mockedPlanGitWorktree.mockResolvedValue(PLANNED_CREATE);
  mockedPreflightDetachedTmuxPi.mockResolvedValue({ ok: true });
  mockedApplyGitWorktreePlan.mockResolvedValue(CREATED_WORKTREE);
  mockedLaunchDetachedTmuxPi.mockResolvedValue({
    requested: true,
    ok: true,
    mode: 'tmux-detached',
    status: 'launched',
    tmuxSessionName: 'pi-project-feature',
    tmuxTarget: '=pi-project-feature',
    message: 'Started a detached tmux Pi session.',
    manualAttachCommand: 'tmux attach-session -t =pi-project-feature',
  });
});

describe('session-deck worktree orchestration', () => {
  it('stops before planning when repo intent cannot be resolved', async () => {
    mockedResolveRepoIntent.mockResolvedValueOnce({
      ok: false,
      reason: 'unresolved',
      message: 'Choose a repo first.',
    });

    await expect(orchestrateCreateWorktree(REQUEST)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: { reason: 'repo-intent-unresolved' },
    });
    expect(mockedPlanGitWorktree).not.toHaveBeenCalled();
    expect(mockedPreflightDetachedTmuxPi).not.toHaveBeenCalled();
    expect(mockedApplyGitWorktreePlan).not.toHaveBeenCalled();
    expect(mockedLaunchDetachedTmuxPi).not.toHaveBeenCalled();
  });

  it('stops before planning when repo intent is ambiguous', async () => {
    mockedResolveRepoIntent.mockResolvedValueOnce({
      ok: false,
      reason: 'ambiguous',
      message: 'Choose a more specific repo.',
    });

    await expect(orchestrateCreateWorktree(REQUEST)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: { reason: 'repo-intent-ambiguous' },
    });
    expect(mockedPlanGitWorktree).not.toHaveBeenCalled();
    expect(mockedPreflightDetachedTmuxPi).not.toHaveBeenCalled();
    expect(mockedApplyGitWorktreePlan).not.toHaveBeenCalled();
    expect(mockedLaunchDetachedTmuxPi).not.toHaveBeenCalled();
  });

  it.each(['invalid-branch', 'invalid-base-ref', 'path-collision'] as const)(
    'does not preflight, apply, or launch when planning fails with %s',
    async (reason) => {
      mockedPlanGitWorktree.mockResolvedValueOnce({
        ok: false,
        reason,
        message: reason,
        recoverable: true,
      });

      await expect(orchestrateCreateWorktree(REQUEST)).resolves.toMatchObject({
        ok: false,
        status: 'failed',
        failurePhase: 'planning',
        worktree: { reason },
      });
      expect(mockedPreflightDetachedTmuxPi).not.toHaveBeenCalled();
      expect(mockedApplyGitWorktreePlan).not.toHaveBeenCalled();
      expect(mockedLaunchDetachedTmuxPi).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['tmux-unavailable', 'New Pi session requires tmux on PATH; no worktree was created.'],
    [
      'pi-command-unavailable',
      'New Pi session requires the pi executable on PATH; no worktree was created.',
    ],
  ] as const)('returns preflight-failed for %s before apply or launch', async (reason, message) => {
    mockedPreflightDetachedTmuxPi.mockResolvedValueOnce({ ok: false, reason });

    await expect(orchestrateCreateWorktree(REQUEST)).resolves.toEqual({
      ok: false,
      status: 'preflight-failed',
      failurePhase: 'preflight',
      preflight: {
        reason,
        recoverable: true,
        message,
      },
      worktree: { requested: false, status: 'not-started' },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    });
    expect(mockedApplyGitWorktreePlan).not.toHaveBeenCalled();
    expect(mockedLaunchDetachedTmuxPi).not.toHaveBeenCalled();
  });

  it('does not launch when applying the worktree fails', async () => {
    mockedApplyGitWorktreePlan.mockResolvedValueOnce({
      ok: false,
      reason: 'git-failed',
      message: 'git failed',
      recoverable: true,
    });

    await expect(orchestrateCreateWorktree(REQUEST)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      failurePhase: 'worktree',
      worktree: { reason: 'git-failed' },
    });
    expect(mockedLaunchDetachedTmuxPi).not.toHaveBeenCalled();
  });

  it('returns created-and-launched, threads ambient agent dir, and omits waiting-for-session updates', async () => {
    const updates: string[] = [];

    await expect(
      orchestrateCreateWorktree(REQUEST, {
        onStatus: (update) => {
          updates.push(update.stage);
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'created-and-launched',
      worktree: { status: 'created' },
      launch: { requested: true, ok: true, status: 'launched' },
    });

    expect(updates).toEqual(['creating-worktree', 'starting-pi']);
    expect(mockedLaunchDetachedTmuxPi).toHaveBeenCalledWith(
      CREATED_WORKTREE,
      'feature/test',
      expect.objectContaining({ agentDir: { mode: 'ambient' } }),
    );
  });

  it('fails before launch when agent dir selection is invalid', async () => {
    await expect(
      orchestrateCreateWorktree({
        ...REQUEST,
        launch: {
          mode: 'tmux-detached',
          agentDir: { mode: 'custom', customDir: 'relative' } as never,
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: { reason: 'invalid-request' },
    });
    expect(mockedResolveRepoIntent).not.toHaveBeenCalled();
    expect(mockedLaunchDetachedTmuxPi).not.toHaveBeenCalled();
  });

  it('threads explicit custom agent dir to launch', async () => {
    await orchestrateCreateWorktree({
      ...REQUEST,
      launch: {
        mode: 'tmux-detached',
        agentDir: { mode: 'custom', customDir: '/Users/test/.pi/agent-work' },
      },
    });

    expect(mockedLaunchDetachedTmuxPi).toHaveBeenCalledWith(
      CREATED_WORKTREE,
      'feature/test',
      expect.objectContaining({
        agentDir: { mode: 'custom', customDir: '/Users/test/.pi/agent-work' },
      }),
    );
  });

  it('returns reused-and-launched when apply reuses an existing worktree', async () => {
    mockedApplyGitWorktreePlan.mockResolvedValueOnce({
      ...CREATED_WORKTREE,
      status: 'reused',
    });

    await expect(orchestrateCreateWorktree(REQUEST)).resolves.toMatchObject({
      ok: true,
      status: 'reused-and-launched',
      worktree: { status: 'reused' },
      launch: { requested: true, ok: true, status: 'launched' },
    });
  });

  it('returns a retained partial launch failure when tmux spawn fails after worktree success', async () => {
    mockedLaunchDetachedTmuxPi.mockResolvedValueOnce({
      requested: true,
      ok: false,
      mode: 'tmux-detached',
      status: 'failed',
      reason: 'spawn-failed',
      recoverable: true,
      message: 'Created worktree, but tmux could not start Pi: boom',
      manualCommand: 'cd /tmp/project-wt-feature-test && exec pi --name feature/test',
    });

    await expect(orchestrateCreateWorktree(REQUEST)).resolves.toMatchObject({
      ok: false,
      status: 'partial-launch-failed',
      failurePhase: 'launch',
      worktree: { status: 'created' },
      worktreeRetained: true,
      launch: { requested: true, ok: false, reason: 'spawn-failed' },
    });
  });
});
