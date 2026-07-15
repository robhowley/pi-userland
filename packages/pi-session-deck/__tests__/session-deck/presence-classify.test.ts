import { describe, expect, it, vi } from 'vitest';
import { classifyPresenceRecord } from '../../extensions/session-deck/presence/classify.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

function buildRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    runtimeId: 'runtime-1',
    pid: 1234,
    startedAt: '2026-06-12T11:55:00.000Z',
    heartbeatAt: '2026-06-12T11:59:55.000Z',
    ...overrides,
  };
}

describe('classifyPresenceRecord', () => {
  it.each([
    {
      ageMs: 30_000,
      state: 'live',
      reason: 'fresh_heartbeat',
    },
    {
      ageMs: 30_001,
      state: 'stale',
      reason: 'heartbeat_expired',
    },
    {
      ageMs: 300_001,
      state: 'dead',
      reason: 'heartbeat_expired',
    },
  ] as const)('applies heartbeat thresholds for age=$ageMs', async ({ ageMs, state, reason }) => {
    const inspectPid = vi.fn(async () => ({ status: 'matches' as const }));
    const heartbeatAt = new Date(NOW.getTime() - ageMs).toISOString();

    const result = await classifyPresenceRecord(buildRecord({ heartbeatAt }), {
      now: NOW,
      inspectPid,
    });

    expect(result.presenceState).toBe(state);
    expect(result.reason).toBe(reason);
    expect(result.heartbeatAgeMs).toBe(ageMs);

    if (state === 'dead') {
      expect(inspectPid).not.toHaveBeenCalled();
    }
  });

  it('marks a fresh record stale when pid validation is insufficient', async () => {
    const result = await classifyPresenceRecord(buildRecord(), {
      now: NOW,
      inspectPid: async () => ({ status: 'unverified', reason: 'pid_unverified' }),
    });

    expect(result.presenceState).toBe('stale');
    expect(result.reason).toBe('pid_unverified');
  });

  it('marks a fresh record dead when the pid is missing', async () => {
    const result = await classifyPresenceRecord(buildRecord(), {
      now: NOW,
      inspectPid: async () => ({ status: 'missing', reason: 'pid_missing' }),
    });

    expect(result.presenceState).toBe('dead');
    expect(result.reason).toBe('pid_missing');
  });

  it('marks a fresh record dead when pid reuse is proven', async () => {
    const result = await classifyPresenceRecord(buildRecord(), {
      now: NOW,
      inspectPid: async () => ({ status: 'reused', reason: 'pid_reused' }),
    });

    expect(result.presenceState).toBe('dead');
    expect(result.reason).toBe('pid_reused');
  });

  it.each(['startedAt', 'heartbeatAt'] as const)(
    'allows %s at the future-skew boundary',
    async (field) => {
      const inspectPid = vi.fn(async () => ({ status: 'matches' as const }));
      const result = await classifyPresenceRecord(
        buildRecord({ [field]: '2026-06-12T12:00:10.000Z' }),
        {
          now: NOW,
          inspectPid,
        },
      );

      expect(result.presenceState).toBe('live');
      expect(result.reason).toBe('fresh_heartbeat');
      expect(inspectPid).toHaveBeenCalledOnce();
    },
  );

  it.each(['startedAt', 'heartbeatAt'] as const)(
    'marks %s beyond the future-skew boundary unknown',
    async (field) => {
      const inspectPid = vi.fn(async () => ({ status: 'matches' as const }));
      const result = await classifyPresenceRecord(
        buildRecord({ [field]: '2026-06-12T12:00:10.001Z' }),
        {
          now: NOW,
          inspectPid,
        },
      );

      expect(result.presenceState).toBe('unknown');
      expect(result.reason).toBe('future_timestamp');
      expect(inspectPid).not.toHaveBeenCalled();
    },
  );

  it('honors future-skew threshold overrides', async () => {
    const inspectPid = vi.fn(async () => ({ status: 'matches' as const }));
    const result = await classifyPresenceRecord(
      buildRecord({ heartbeatAt: '2026-06-12T12:00:02.000Z' }),
      {
        now: NOW,
        thresholds: { futureSkewMs: 1_000 },
        inspectPid,
      },
    );

    expect(result.presenceState).toBe('unknown');
    expect(result.reason).toBe('future_timestamp');
    expect(inspectPid).not.toHaveBeenCalled();
  });
});
