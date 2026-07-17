import { describe, expect, it } from 'vitest';
import {
  normalizeActionRequest,
  normalizeLaunchContextPreviewRequest,
  toBrowserSafeCreateWorktreeActionResult,
} from '../../extensions/session-deck/worktree/action-cli.js';
import type { CreateWorktreeActionResult } from '../../extensions/session-deck/worktree/types.js';

describe('session-deck worktree action cli', () => {
  it('defaults an absent launch block to tmux-detached', () => {
    expect(
      normalizeActionRequest({
        repoIntent: {
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
      }),
    ).toEqual({
      ok: true,
      request: {
        repoIntent: {
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
      },
    });
  });

  it('accepts one-shot default and custom launch agent dir selectors', () => {
    expect(
      normalizeActionRequest({
        repoIntent: {
          repoName: 'project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'default' } },
      }),
    ).toMatchObject({
      ok: true,
      request: { launch: { agentDir: { mode: 'default' } } },
    });

    expect(
      normalizeActionRequest({
        repoIntent: {
          repoName: 'project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
        launch: {
          mode: 'tmux-detached',
          agentDir: { mode: 'custom', customDir: '~/agent-or/../agent-work' },
        },
      }),
    ).toMatchObject({
      ok: true,
      request: { launch: { agentDir: { mode: 'custom' } } },
    });
    const result = normalizeActionRequest({
      repoIntent: {
        repoName: 'project',
        candidateRuntimeIds: ['rt-1'],
      },
      branchName: 'feature/test',
      launch: {
        mode: 'tmux-detached',
        agentDir: { mode: 'custom', customDir: '~/agent-or/../agent-work' },
      },
    });
    expect(result.ok && result.request.launch?.agentDir?.customDir).toMatch(/\/agent-work$/u);
  });

  it('rejects invalid launch agent dir selectors and recursive path fields', () => {
    expect(
      normalizeActionRequest({
        repoIntent: { repoName: 'project', candidateRuntimeIds: ['rt-1'] },
        branchName: 'feature/test',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'default', customDir: '/tmp/pi' } },
      }),
    ).toEqual({ ok: false, message: 'launch.agentDir.customDir is only valid for custom mode.' });

    expect(
      normalizeActionRequest({
        repoIntent: { repoName: 'project', candidateRuntimeIds: ['rt-1'] },
        branchName: 'feature/test',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'custom', customDir: 'relative' } },
      }),
    ).toEqual({
      ok: false,
      message: 'launch.agentDir.customDir must be absolute or start with ~/.',
    });

    expect(
      normalizeLaunchContextPreviewRequest({
        action: 'preview-launch-context',
        launch: { agentDir: { mode: 'custom', path: '/tmp/pi' } },
      }),
    ).toEqual({
      ok: false,
      message: 'Field is not accepted by this action boundary: launch.agentDir.path',
    });

    expect(
      normalizeLaunchContextPreviewRequest({
        action: 'preview-launch-context',
        launch: {
          mode: 'tmux-detached',
          agentDir: { mode: 'default' },
          candidates: [{ path: '/tmp/pi' }],
        },
      }),
    ).toEqual({
      ok: false,
      message: 'Field is not accepted by this action boundary: launch.candidates.0.path',
    });
  });

  it('normalizes launch-context preview requests through the structured launch object', () => {
    expect(
      normalizeLaunchContextPreviewRequest({
        action: 'preview-launch-context',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'default' } },
      }),
    ).toEqual({ ok: true, request: { agentDir: { mode: 'default' } } });
  });

  it('rejects explicit launch.mode none at the public boundary', () => {
    expect(
      normalizeActionRequest({
        repoIntent: {
          repoName: 'project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
        launch: { mode: 'none' },
      }),
    ).toEqual({ ok: false, message: 'launch.mode must be tmux-detached when provided.' });
  });

  it('rejects unknown launch modes at the public boundary', () => {
    expect(
      normalizeActionRequest({
        repoIntent: {
          repoName: 'project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
        launch: { mode: 'rpc' },
      }),
    ).toEqual({ ok: false, message: 'launch.mode must be tmux-detached when provided.' });
  });

  it('rejects public path overrides', () => {
    expect(
      normalizeActionRequest({
        repoIntent: {
          repoName: 'project',
          candidateRuntimeIds: ['rt-1'],
        },
        branchName: 'feature/test',
        path: '/tmp/private',
      }),
    ).toEqual({
      ok: false,
      message: 'Field is not accepted by this action boundary: path',
    });
  });

  it('maps planning failures to browser-safe messages', () => {
    const result: CreateWorktreeActionResult = {
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: {
        ok: false,
        reason: 'invalid-branch',
        message: 'Invalid Git branch name: rh/bad..branch',
        recoverable: true,
      },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    };

    expect(toBrowserSafeCreateWorktreeActionResult(result)).toEqual({
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: {
        ok: false,
        reason: 'invalid-branch',
        message: 'Branch name is not valid.',
        recoverable: true,
      },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    });
  });

  it('distinguishes preflight failures from partial launch failures in browser-safe output', () => {
    const preflight: CreateWorktreeActionResult = {
      ok: false,
      status: 'preflight-failed',
      failurePhase: 'preflight',
      preflight: {
        reason: 'tmux-unavailable',
        recoverable: true,
        message: 'internal',
      },
      worktree: { requested: false, status: 'not-started' },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    };
    const partial: CreateWorktreeActionResult = {
      ok: false,
      status: 'partial-launch-failed',
      failurePhase: 'launch',
      worktreeRetained: true,
      worktree: {
        ok: true,
        status: 'created',
        path: '/tmp/project-wt-feature',
        branch: 'feature/test',
        baseRef: 'origin/main',
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
        manualCommand: 'git worktree add ...',
      },
      launch: {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'spawn-failed',
        recoverable: true,
        message: 'internal launch failure',
        manualCommand: 'cd /tmp/project-wt-feature && exec pi --name feature/test',
      },
    };

    expect(toBrowserSafeCreateWorktreeActionResult(preflight)).toEqual({
      ok: false,
      status: 'preflight-failed',
      failurePhase: 'preflight',
      preflight: {
        reason: 'tmux-unavailable',
        recoverable: true,
        message: 'New Pi session requires tmux on PATH; no worktree was created.',
      },
      worktree: { requested: false, status: 'not-started' },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    });

    expect(toBrowserSafeCreateWorktreeActionResult(partial)).toEqual({
      ok: false,
      status: 'partial-launch-failed',
      failurePhase: 'launch',
      worktreeRetained: true,
      worktree: {
        ok: true,
        status: 'created',
        branch: 'feature/test',
        baseRef: 'origin/main',
        repoName: 'project',
        qualifiedRepoName: 'owner/project',
      },
      launch: {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'spawn-failed',
        recoverable: true,
        message: 'Created worktree, but tmux could not start Pi.',
      },
    });
  });
});
