import { describe, expect, it, vi } from 'vitest';
import {
  normalizeKillSessionActionRequest,
  runKillSessionAction,
  toBrowserSafeKillSessionActionResult,
  type KillSessionFailureReason,
} from '../../extensions/session-deck/iterm2/kill-action-cli.js';

const SENSITIVE_STRINGS = [
  '/Users/example/.pi/session-deck/presence/rt-1.json',
  '/tmp/tmux/default',
  'kill -9 1234',
  'tmux kill-session -t prod',
  'secret-runtime',
];

describe('kill-session action helper request boundary', () => {
  it('accepts exact runtimeId payloads and rejects extra or unsafe fields', () => {
    expect(normalizeKillSessionActionRequest({ runtimeId: 'rt-123_ABC.def' })).toEqual({
      ok: true,
      request: { runtimeId: 'rt-123_ABC.def' },
    });

    for (const invalid of [
      null,
      [],
      {},
      { runtimeId: '' },
      { runtimeId: ' rt-1' },
      { runtimeId: 'rt 1' },
      { runtimeId: 'rt/1' },
      { runtimeId: 'rt\\1' },
      { runtimeId: 'rt:1' },
      { runtimeId: '.rt-1' },
      { runtimeId: '.' },
      { runtimeId: '..' },
      { runtimeId: 'a'.repeat(257) },
      { runtimeId: 123 },
      { runtimeId: 'rt-1', extra: true },
      { runtimeId: 'rt-1', pid: 1234 },
      { runtimeId: 'rt-1', signal: 'SIGKILL' },
      { runtimeId: 'rt-1', cwd: '/tmp/private' },
      { runtimeId: 'rt-1', sessionFile: '/tmp/session.jsonl' },
      { runtimeId: 'rt-1', terminal: { tmux: true } },
      { runtimeId: 'rt-1', tmux: { command: 'kill-session' } },
      { runtimeId: 'rt-1', iTerm2: { socketPath: '/tmp/private.sock' } },
      { runtimeId: 'rt-1', socket: '/tmp/private.sock' },
      { runtimeId: 'rt-1', shell: '/bin/zsh' },
      { runtimeId: 'rt-1', command: 'kill 1234' },
    ]) {
      expect(normalizeKillSessionActionRequest(invalid).ok).toBe(false);
    }
  });

  it('calls the killer with runtimeId only and maps success to browser-safe copy', async () => {
    const killer = vi.fn(async (_runtimeId: string) => ({
      ok: true as const,
      status: 'signal-sent' as const,
    }));

    const result = await runKillSessionAction({ runtimeId: 'rt-1' }, killer);

    expect(killer).toHaveBeenCalledWith('rt-1');
    expect(killer.mock.calls[0]).toEqual(['rt-1']);
    expect(result).toEqual({
      ok: true,
      status: 'requested',
      message: 'End requested for this session.',
    });
  });

  it('maps already-exited and semantic failures to fixed safe messages', () => {
    expect(toBrowserSafeKillSessionActionResult({ ok: true, status: 'already-exited' })).toEqual({
      ok: true,
      status: 'already-exited',
      message: 'This Pi session is no longer running.',
    });

    const reasons: KillSessionFailureReason[] = [
      'invalid-runtime-id',
      'presence-missing',
      'presence-malformed',
      'runtime-mismatch',
      'pid-reused',
      'pid-unverified',
      'self-signal-denied',
      'permission-denied',
      'signal-failed',
    ];

    for (const reason of reasons) {
      const safe = toBrowserSafeKillSessionActionResult({ ok: false, reason });
      expect(safe.ok).toBe(false);
      expect(safe).toMatchObject({ status: 'failed', reason });
      for (const secret of SENSITIVE_STRINGS) {
        expect(JSON.stringify(safe)).not.toContain(secret);
      }
    }
  });

  it('turns unexpected killer exceptions into safe signal-failed results', async () => {
    const result = await runKillSessionAction({ runtimeId: 'rt-1' }, async () => {
      throw new Error(`boom ${SENSITIVE_STRINGS.join(' ')}`);
    });

    expect(result).toEqual({
      ok: false,
      status: 'failed',
      reason: 'signal-failed',
      message: 'Could not request session end.',
    });
    for (const secret of SENSITIVE_STRINGS) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
