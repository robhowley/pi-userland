import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLocalUsageDir, addUtcDays, dedupeLocalUsageEvents } from '../local-usage.js';
import {
  calculateOpenRouterStatusStats,
  formatOpenRouterStatusBar,
  loadOpenRouterStatusBar,
  loadOpenRouterStatusStats,
} from '../status-bar.js';
import type { LocalUsageEvent } from '../types.js';

let testDir: string;

function createLocalUsageEvent(
  id: string,
  completedAt: string,
  cost: number,
  overrides: Partial<LocalUsageEvent> = {},
): LocalUsageEvent {
  return {
    id,
    generationId: `${id}-generation`,
    sessionId: 'session-test',
    completedAt,
    requests: 1,
    model: 'openrouter/anthropic/claude-sonnet-4',
    provider: 'anthropic',
    promptTokens: 10,
    completionTokens: 5,
    cost,
    ...overrides,
  };
}

async function writeDailyFile(
  dateUtc: string,
  rows: Array<LocalUsageEvent | string>,
): Promise<void> {
  const content = rows
    .map((row) => (typeof row === 'string' ? row : JSON.stringify(row)))
    .join('\n');
  await fs.writeFile(path.join(testDir, `${dateUtc}.jsonl`), `${content}\n`, 'utf8');
}

beforeEach(async () => {
  testDir = path.join(
    os.tmpdir(),
    `pi-openrouter-status-bar-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(testDir, { recursive: true });
  setLocalUsageDir(testDir);
});

afterEach(async () => {
  setLocalUsageDir(null);
  vi.restoreAllMocks();
  vi.doUnmock('../local-usage.js');
  vi.doUnmock('../status-bar.js');

  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
});

describe('calculateOpenRouterStatusStats', () => {
  it('returns a clearable empty state for no local events', () => {
    const stats = calculateOpenRouterStatusStats([], '2026-05-22');

    expect(stats).toEqual({
      todayLocalSpend: 0,
      averageLocalDailySpendLast30Days: 0,
      burnRateMultiplier: null,
      hasLocalSpendInWindow: false,
    });
    expect(formatOpenRouterStatusBar(stats)).toBeNull();
  });

  it('clears the status when the full 30-day window totals zero local spend', () => {
    const stats = calculateOpenRouterStatusStats(
      [
        createLocalUsageEvent('today-zero', '2026-05-22T09:15:00.000Z', 0),
        createLocalUsageEvent('older-zero', '2026-05-12T09:15:00.000Z', 0),
      ],
      '2026-05-22',
    );

    expect(stats).toEqual({
      todayLocalSpend: 0,
      averageLocalDailySpendLast30Days: 0,
      burnRateMultiplier: null,
      hasLocalSpendInWindow: false,
    });
    expect(formatOpenRouterStatusBar(stats)).toBeNull();
  });

  it('includes only UTC-today spend and divides by exactly 30 calendar days', () => {
    const stats = calculateOpenRouterStatusStats(
      [
        createLocalUsageEvent('today', '2026-05-22T09:15:00.000Z', 3),
        createLocalUsageEvent('yesterday', '2026-05-21T09:15:00.000Z', 9),
      ],
      '2026-05-22',
    );

    expect(stats.todayLocalSpend).toBe(3);
    expect(stats.averageLocalDailySpendLast30Days).toBeCloseTo(0.4, 10);
    expect(stats.burnRateMultiplier).toBeCloseTo(7.5, 10);
    expect(stats.hasLocalSpendInWindow).toBe(true);
  });

  it('uses only the today-29 through today window', () => {
    const stats = calculateOpenRouterStatusStats(
      [
        createLocalUsageEvent('old', '2026-04-22T12:00:00.000Z', 100),
        createLocalUsageEvent('boundary', '2026-04-23T12:00:00.000Z', 6),
        createLocalUsageEvent('recent', '2026-05-21T12:00:00.000Z', 3),
        createLocalUsageEvent('today', '2026-05-22T12:00:00.000Z', 1.5),
      ],
      '2026-05-22',
    );

    expect(stats.todayLocalSpend).toBe(1.5);
    expect(stats.averageLocalDailySpendLast30Days).toBeCloseTo(0.35, 10);
    expect(stats.burnRateMultiplier).toBeCloseTo(1.5 / 0.35, 10);
  });

  it('deduplicates event ids exactly once across the full 30-day window', () => {
    const events = [
      createLocalUsageEvent('duplicate-id', '2026-05-20T12:00:00.000Z', 1),
      createLocalUsageEvent('duplicate-id', '2026-05-22T12:00:00.000Z', 99),
      createLocalUsageEvent('unique-id', '2026-05-22T13:00:00.000Z', 2),
    ];

    expect(dedupeLocalUsageEvents(events)).toHaveLength(2);

    const stats = calculateOpenRouterStatusStats(events, '2026-05-22');

    expect(stats).toEqual({
      todayLocalSpend: 2,
      averageLocalDailySpendLast30Days: 0.1,
      burnRateMultiplier: 20,
      hasLocalSpendInWindow: true,
    });
  });
});

describe('formatOpenRouterStatusBar', () => {
  it('formats the representative status text exactly', () => {
    const stats = calculateOpenRouterStatusStats(
      [
        createLocalUsageEvent('today', '2026-05-22T12:00:00.000Z', 2.14),
        createLocalUsageEvent('older', '2026-05-12T12:00:00.000Z', 47.06),
      ],
      '2026-05-22',
    );

    expect(formatOpenRouterStatusBar(stats)).toBe('OR $2.14 today · 1.3x 30d avg');
  });

  it('formats $0.00 today · 0.0x 30d avg when prior 30-day spend exists but today spend is zero', () => {
    const stats = calculateOpenRouterStatusStats(
      [createLocalUsageEvent('older', '2026-05-12T12:00:00.000Z', 15)],
      '2026-05-22',
    );

    expect(formatOpenRouterStatusBar(stats)).toBe('OR $0.00 today · 0.0x 30d avg');
  });

  it('omits the multiplier when given a clearable stats object with no denominator', () => {
    expect(
      formatOpenRouterStatusBar({
        todayLocalSpend: 2.14,
        averageLocalDailySpendLast30Days: 0,
        burnRateMultiplier: null,
        hasLocalSpendInWindow: true,
      }),
    ).toBe('OR $2.14 today');
  });
});

describe('loadOpenRouterStatusStats', () => {
  it('returns null for empty local usage data', async () => {
    const now = new Date('2026-05-22T12:00:00.000Z');

    await expect(loadOpenRouterStatusStats(now)).resolves.toBeNull();
    await expect(loadOpenRouterStatusBar(now)).resolves.toBeNull();
  });

  it('returns null when the 30-day window has only zero-cost local rows', async () => {
    await writeDailyFile('2026-05-12', [
      createLocalUsageEvent('older-zero', '2026-05-12T12:00:00.000Z', 0),
    ]);
    await writeDailyFile('2026-05-22', [
      createLocalUsageEvent('today-zero', '2026-05-22T12:00:00.000Z', 0),
    ]);

    const now = new Date('2026-05-22T12:00:00.000Z');

    await expect(loadOpenRouterStatusStats(now)).resolves.toBeNull();
    await expect(loadOpenRouterStatusBar(now)).resolves.toBeNull();
  });

  it('reads local files only from today-29 through today and ignores older files', async () => {
    await writeDailyFile('2026-04-22', [
      createLocalUsageEvent('too-old', '2026-04-22T12:00:00.000Z', 100),
    ]);
    await writeDailyFile('2026-04-23', [
      createLocalUsageEvent('boundary', '2026-04-23T12:00:00.000Z', 1),
    ]);
    await writeDailyFile('2026-05-22', [
      createLocalUsageEvent('today', '2026-05-22T12:00:00.000Z', 2),
    ]);

    vi.resetModules();
    const actualLocalUsage =
      await vi.importActual<typeof import('../local-usage.js')>('../local-usage.js');
    const readLocalUsage = vi.fn(actualLocalUsage.readLocalUsage);

    vi.doMock('../local-usage.js', () => ({
      ...actualLocalUsage,
      readLocalUsage,
    }));

    const { loadOpenRouterStatusStats: loadMockedStats } = await import('../status-bar.js');
    const localUsage = await import('../local-usage.js');
    localUsage.setLocalUsageDir(testDir);

    const stats = await loadMockedStats(new Date('2026-05-22T12:00:00.000Z'));

    expect(stats).toEqual({
      todayLocalSpend: 2,
      averageLocalDailySpendLast30Days: 0.1,
      burnRateMultiplier: 20,
      hasLocalSpendInWindow: true,
    });
    expect(readLocalUsage).toHaveBeenCalledTimes(1);
    expect(readLocalUsage).toHaveBeenCalledWith({
      fromDateUtc: '2026-04-23',
      toDateUtc: '2026-05-22',
    });

    localUsage.setLocalUsageDir(null);
  });

  it('tolerates missing files and malformed rows while still formatting the status', async () => {
    await writeDailyFile('2026-05-10', [
      createLocalUsageEvent('older', '2026-05-10T12:00:00.000Z', 4),
      '{not json}',
    ]);
    await writeDailyFile('2026-05-22', [
      createLocalUsageEvent('today', '2026-05-22T12:00:00.000Z', 2),
      '',
    ]);

    const stats = await loadOpenRouterStatusStats(new Date('2026-05-22T12:00:00.000Z'));

    expect(stats).toEqual({
      todayLocalSpend: 2,
      averageLocalDailySpendLast30Days: 0.2,
      burnRateMultiplier: 10,
      hasLocalSpendInWindow: true,
    });
    expect(await loadOpenRouterStatusBar(new Date('2026-05-22T12:00:00.000Z'))).toBe(
      'OR $2.00 today · 10.0x 30d avg',
    );
  });

  it('returns null when the local usage read path throws unexpectedly', async () => {
    vi.resetModules();

    const readLocalUsage = vi.fn().mockRejectedValue(new Error('disk exploded'));
    vi.doMock('../local-usage.js', async () => {
      const actual = await vi.importActual<typeof import('../local-usage.js')>('../local-usage.js');
      return {
        ...actual,
        readLocalUsage,
      };
    });

    const { loadOpenRouterStatusStats: loadMockedStats, loadOpenRouterStatusBar: loadMockedBar } =
      await import('../status-bar.js');

    const now = new Date('2026-05-22T12:00:00.000Z');
    const expectedFromDateUtc = addUtcDays('2026-05-22', -29);

    await expect(loadMockedStats(now)).resolves.toBeNull();
    await expect(loadMockedBar(now)).resolves.toBeNull();
    expect(readLocalUsage).toHaveBeenCalledWith({
      fromDateUtc: expectedFromDateUtc,
      toDateUtc: '2026-05-22',
    });
  });
});
