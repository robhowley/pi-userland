import { describe, expect, it } from 'vitest';
import { normalizeCreateSessionActionRequest } from '../../extensions/session-deck/session/create.js';
import type { CreateSessionActionResult } from '../../extensions/session-deck/session/types.js';
import {
  getRequestedAction,
  normalizeActionRequest,
  normalizeLaunchContextPreviewRequest,
  runCreateSessionAction,
  toBrowserSafeCreateSessionActionResult,
  toBrowserSafeCreateWorktreeActionResult,
} from '../../extensions/session-deck/worktree/action-cli.js';
import type { CreateWorktreeActionResult } from '../../extensions/session-deck/worktree/types.js';

describe('session-deck worktree action cli', () => {
  it('detects create-session while keeping absent action as create-worktree', () => {
    expect(getRequestedAction({ cwd: '/tmp/scratch' })).toEqual({
      ok: true,
      action: 'create-worktree',
    });
    expect(getRequestedAction({ action: 'create-session', cwd: '/tmp/scratch' })).toEqual({
      ok: true,
      action: 'create-session',
    });
  });

  it('normalizes create-session cwd and launch agent dir without repo intent', () => {
    expect(
      normalizeCreateSessionActionRequest({
        action: 'create-session',
        cwd: '/tmp/scratch/../scratch',
      }),
    ).toEqual({
      ok: true,
      request: {
        action: 'create-session',
        cwd: '/tmp/scratch',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'ambient' } },
      },
    });

    expect(
      normalizeCreateSessionActionRequest(
        {
          action: 'create-session',
          cwd: '~/scratch',
          launch: {
            mode: 'tmux-detached',
            agentDir: { mode: 'custom', customDir: '~/agent-work' },
          },
        },
        { homeDir: '/Users/test' },
      ),
    ).toEqual({
      ok: true,
      request: {
        action: 'create-session',
        cwd: '/Users/test/scratch',
        launch: {
          mode: 'tmux-detached',
          agentDir: { mode: 'custom', customDir: '/Users/test/agent-work' },
        },
      },
    });

    expect(
      normalizeCreateSessionActionRequest(
        { action: 'create-session', cwd: '~' },
        { homeDir: '/Users/test' },
      ),
    ).toMatchObject({ ok: true, request: { cwd: '/Users/test' } });
  });

  it.each([
    ['missing cwd', { action: 'create-session' }, 'cwd is required.'],
    ['empty cwd', { action: 'create-session', cwd: '   ' }, 'Working directory is required.'],
    [
      'relative cwd',
      { action: 'create-session', cwd: 'scratch' },
      'Working directory must be absolute, ~, or start with ~/.',
    ],
    [
      'tilde user cwd',
      { action: 'create-session', cwd: '~other/scratch' },
      'Working directory must be absolute, ~, or start with ~/.',
    ],
    [
      'newline cwd',
      { action: 'create-session', cwd: '/tmp/scratch\nnext' },
      'Working directory must not contain newlines or NUL bytes.',
    ],
    [
      'nul cwd',
      { action: 'create-session', cwd: '/tmp/scratch\0next' },
      'Working directory must not contain newlines or NUL bytes.',
    ],
  ])('rejects create-session %s', (_label, payload, message) => {
    expect(normalizeCreateSessionActionRequest(payload)).toMatchObject({
      ok: false,
      message,
    });
  });

  it.each([
    'repoIntent',
    'branchName',
    'baseRef',
    'path',
    'manualCommand',
    'manualAttachCommand',
    'tmuxSessionName',
    'tmuxTarget',
    'sessionFile',
  ])('rejects create-session field %s', (field) => {
    expect(
      normalizeCreateSessionActionRequest({
        action: 'create-session',
        cwd: '/tmp/scratch',
        [field]: 'private',
      }),
    ).toEqual({
      ok: false,
      reason: 'invalid-request',
      message: `Field is not accepted by this action boundary: ${field}`,
    });
  });

  it('keeps launch-context preview cwd-free', () => {
    expect(
      normalizeLaunchContextPreviewRequest({
        action: 'preview-launch-context',
        cwd: '/tmp/scratch',
        launch: { mode: 'tmux-detached', agentDir: { mode: 'default' } },
      }),
    ).toEqual({
      ok: false,
      message: 'Field is not accepted by this action boundary: cwd',
    });
  });

  it('returns create-session cwd syntax errors as browser-safe validation results', async () => {
    await expect(
      runCreateSessionAction({ action: 'create-session', cwd: 'relative' }),
    ).resolves.toEqual({
      ok: false,
      status: 'failed',
      failurePhase: 'validation',
      reason: 'invalid-cwd',
      message: 'Working directory must be absolute, ~, or start with ~/.',
      recoverable: true,
    });
  });

  it('maps create-session results without worktree fields or copy', () => {
    const preflight: CreateSessionActionResult = {
      ok: false,
      status: 'preflight-failed',
      failurePhase: 'preflight',
      preflight: { reason: 'tmux-unavailable', recoverable: true, message: 'internal' },
      launch: { requested: false, mode: 'tmux-detached', status: 'not-started' },
    };
    const launchFailed: CreateSessionActionResult = {
      ok: false,
      status: 'launch-failed',
      failurePhase: 'launch',
      cwd: '/tmp/scratch',
      launch: {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'spawn-failed',
        recoverable: true,
        message: 'internal failure /tmp/private',
        manualCommand: 'cd /tmp/private && pi',
      },
    };
    const success: CreateSessionActionResult = {
      ok: true,
      status: 'launched',
      cwd: '/tmp/scratch',
      launch: {
        requested: true,
        ok: true,
        mode: 'tmux-detached',
        status: 'launched',
        tmuxSessionName: 'pi-private',
        tmuxTarget: '=pi-private',
        message: 'Started a detached tmux Pi session.',
        manualAttachCommand: 'tmux attach-session -t =pi-private',
      },
    };

    expect(toBrowserSafeCreateSessionActionResult(preflight)).toEqual({
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
    expect(toBrowserSafeCreateSessionActionResult(launchFailed)).toEqual({
      ok: false,
      status: 'launch-failed',
      failurePhase: 'launch',
      cwd: '/tmp/scratch',
      launch: {
        requested: true,
        ok: false,
        mode: 'tmux-detached',
        status: 'failed',
        reason: 'spawn-failed',
        recoverable: true,
        message: 'tmux could not start Pi.',
      },
    });
    expect(toBrowserSafeCreateSessionActionResult(success)).toEqual({
      ok: true,
      status: 'launched',
      cwd: '/tmp/scratch',
      launch: {
        requested: true,
        ok: true,
        mode: 'tmux-detached',
        status: 'launched',
        message: 'Started a detached tmux Pi session.',
      },
    });
  });

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
