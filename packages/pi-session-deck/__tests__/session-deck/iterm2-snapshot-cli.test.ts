import { describe, expect, it, vi } from 'vitest';
import { runSessionDeckSnapshotCli } from '../../extensions/session-deck/iterm2/snapshot-cli.js';
import type { SessionDeckSnapshot } from '../../extensions/session-deck/types.js';

function buildSnapshot(overrides: Partial<SessionDeckSnapshot> = {}): SessionDeckSnapshot {
  return {
    generatedAt: '2026-07-10T12:00:00.000Z',
    records: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('runSessionDeckSnapshotCli', () => {
  it('writes the authoritative snapshot JSON to stdout and exits 0', async () => {
    const snapshot = buildSnapshot({
      records: [
        {
          runtimeId: 'rt-1',
          pid: 101,
          presenceState: 'live',
          presenceReason: 'fresh_heartbeat',
          heartbeatAgeMs: 5_000,
          sessionId: 'session-1',
          sessionName: 'alpha',
          repoName: 'repo',
          qualifiedRepoName: 'owner/repo',
          cwd: '/repo',
          branch: 'main',
          prUrl: null,
          isLinkedWorktree: false,
          worktreeLabel: null,
          activityState: 'idle',
          activityAgeMs: null,
          currentToolName: null,
          lastError: null,
          compaction: null,
          chips: ['merge-ready clean'],
          diagnostics: [],
        },
      ],
    });
    const readSnapshot = vi
      .fn<typeof import('../../extensions/session-deck/reader.js').readSessionDeckSnapshot>()
      .mockResolvedValue(snapshot);
    const stdout = { write: vi.fn<(chunk: string) => boolean>().mockReturnValue(true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>().mockReturnValue(true) };

    const exitCode = await runSessionDeckSnapshotCli({ readSnapshot, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith(`${JSON.stringify(snapshot)}\n`);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('writes helper failures to stderr and exits 1', async () => {
    const readSnapshot = vi
      .fn<typeof import('../../extensions/session-deck/reader.js').readSessionDeckSnapshot>()
      .mockRejectedValue(new Error('boom'));
    const stdout = { write: vi.fn<(chunk: string) => boolean>().mockReturnValue(true) };
    const stderr = { write: vi.fn<(chunk: string) => boolean>().mockReturnValue(true) };

    const exitCode = await runSessionDeckSnapshotCli({ readSnapshot, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith('Session Deck snapshot helper failed: boom\n');
  });
});
