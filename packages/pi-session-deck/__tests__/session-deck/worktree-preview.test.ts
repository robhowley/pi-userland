import { describe, expect, it, vi } from 'vitest';
import { normalizeBasePreviewRequest } from '../../extensions/session-deck/worktree/action-cli.js';
import { resolveWorktreeBasePreview } from '../../extensions/session-deck/worktree/preview.js';
import type { WorktreeExecFile } from '../../extensions/session-deck/worktree/git.js';

function buildIdentityRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-abc',
    sessionFile: '/tmp/session-abc.md',
    cwd: '/Users/tester/project',
    worktree: '/Users/tester/project',
    repoName: 'project',
    qualifiedRepoName: 'owner/project',
    branch: 'feature/existing',
    prUrl: null,
    isLinkedWorktree: null,
    worktreeLabel: null,
    identityUpdatedAt: '2026-07-14T12:00:00.000Z',
    sessionStartedAt: '2026-07-14T11:00:00.000Z',
    gitRemote: null,
    gitRoot: null,
    identitySource: 'startup',
    ...overrides,
  };
}

describe('session-deck worktree base preview', () => {
  it('normalizes the narrow preview boundary request', () => {
    expect(
      normalizeBasePreviewRequest({
        action: 'preview-base-ref',
        repoIntent: {
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
          candidateRuntimeIds: ['rt-1'],
        },
      }),
    ).toEqual({
      ok: true,
      request: {
        repoIntent: {
          repoName: 'project',
          qualifiedRepoName: 'owner/project',
          candidateRuntimeIds: ['rt-1'],
        },
      },
    });
  });

  it('resolves the preview baseRef through the shared git helper path', async () => {
    const readFile = vi.fn(async () => JSON.stringify(buildIdentityRecord()));
    const execFile: WorktreeExecFile = async (_file, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: '/Users/tester/project\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') {
        return { stdout: '/Users/tester/project/.git\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'origin/main\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: `unexpected ${args.join(' ')}`, exitCode: 1 };
    };

    await expect(
      resolveWorktreeBasePreview(
        {
          repoIntent: {
            repoName: 'project',
            qualifiedRepoName: 'owner/project',
            candidateRuntimeIds: ['rt-1'],
          },
        },
        {
          identityDirectory: '/tmp/session-deck-identity',
          readFile,
          execFile,
        },
      ),
    ).resolves.toEqual({
      ok: true,
      status: 'resolved',
      baseRef: 'origin/main',
    });
  });

  it('returns an unresolved preview failure when no repo candidates are available', async () => {
    await expect(
      resolveWorktreeBasePreview({
        repoIntent: {
          repoName: 'project',
          candidateRuntimeIds: [],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'repo-intent-unresolved',
      recoverable: true,
    });
  });
});
