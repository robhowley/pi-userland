/**
 * Tests for local usage JSONL storage and aggregation.
 * Phase 6: Local JSONL hardening
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeLocalUsage,
  readLocalUsage,
  aggregateLocal,
  getCurrentUtcDate,
  getUtcDateFromTimestamp,
  addUtcDays,
  cleanupOldUsageFiles,
  setLocalUsageDir,
} from '../local-usage.js';
import type { LocalUsageEvent } from '../types.js';
import { restoreEnv, setEnv, clearEnv } from './fixtures.js';

// Test directory setup
let testDir: string;

beforeEach(async () => {
  // Create a unique test directory for each test
  testDir = path.join(
    os.tmpdir(),
    `pi-openrouter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(testDir, { recursive: true });

  // Tell local-usage to use our test directory
  setLocalUsageDir(testDir);

  // Restore environment
  restoreEnv();

  // Clear any debug flag
  clearEnv('PI_OPENROUTER_DEBUG_USAGE');
});

afterEach(async () => {
  // Reset local usage directory
  setLocalUsageDir(null);

  // Clean up test directory
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  // Restore environment
  restoreEnv();
});

// =============================================================================
// Date Utilities
// =============================================================================

describe('date utilities', () => {
  it('getCurrentUtcDate returns YYYY-MM-DD format', () => {
    const result = getCurrentUtcDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('getUtcDateFromTimestamp extracts date from ISO string', () => {
    const timestamp = '2026-05-22T14:30:00.000Z';
    const result = getUtcDateFromTimestamp(timestamp);
    expect(result).toBe('2026-05-22');
  });

  it('addUtcDays adds positive days correctly', () => {
    const result = addUtcDays('2026-05-22', 3);
    expect(result).toBe('2026-05-25');
  });

  it('addUtcDays subtracts negative days correctly', () => {
    const result = addUtcDays('2026-05-22', -5);
    expect(result).toBe('2026-05-17');
  });

  it('addUtcDays handles month boundaries', () => {
    const result = addUtcDays('2026-05-30', 5);
    expect(result).toBe('2026-06-04');
  });

  it('addUtcDays throws on invalid date', () => {
    expect(() => addUtcDays('invalid', 1)).toThrow('Invalid date string');
  });
});

// =============================================================================
// Write Functionality
// =============================================================================

describe('writeLocalUsage', () => {
  it('writes valid event to daily JSONL file', async () => {
    const event: LocalUsageEvent = {
      id: 'test-123',
      generationId: 'gen-456',
      sessionId: 'session-789',
      completedAt: '2026-05-22T14:30:00.000Z',
      requests: 1,
      model: 'gpt-4',
      provider: 'openai',
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.0025,
    };

    await writeLocalUsage(event);

    // Verify file was created with correct content
    const filePath = path.join(testDir, '2026-05-22.jsonl');
    const content = await fs.readFile(filePath, 'utf8');

    expect(content).toBe(JSON.stringify(event) + '\n');
  });

  it('appends multiple events to same daily file', async () => {
    const event1: LocalUsageEvent = {
      id: 'test-1',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-22T10:00:00.000Z',
      cost: 0.001,
    };

    const event2: LocalUsageEvent = {
      id: 'test-2',
      generationId: 'gen-2',
      sessionId: 'session-2',
      completedAt: '2026-05-22T15:00:00.000Z',
      cost: 0.002,
    };

    await writeLocalUsage(event1);
    await writeLocalUsage(event2);

    const filePath = path.join(testDir, '2026-05-22.jsonl');
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(event1);
    expect(JSON.parse(lines[1]!)).toEqual(event2);
  });

  it('writes to different files for different UTC dates', async () => {
    const event1: LocalUsageEvent = {
      id: 'test-1',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-22T23:59:59.999Z',
      cost: 0.001,
    };

    const event2: LocalUsageEvent = {
      id: 'test-2',
      generationId: 'gen-2',
      sessionId: 'session-2',
      completedAt: '2026-05-23T00:00:00.000Z',
      cost: 0.002,
    };

    await writeLocalUsage(event1);
    await writeLocalUsage(event2);

    const file1 = await fs.readFile(path.join(testDir, '2026-05-22.jsonl'), 'utf8');
    const file2 = await fs.readFile(path.join(testDir, '2026-05-23.jsonl'), 'utf8');

    expect(JSON.parse(file1.trim())).toEqual(event1);
    expect(JSON.parse(file2.trim())).toEqual(event2);
  });

  it('fails open on write error without throwing', async () => {
    // Set to an invalid directory that can't be created
    setLocalUsageDir('/invalid/readonly/path');

    const event: LocalUsageEvent = {
      id: 'test-123',
      generationId: 'gen-456',
      sessionId: 'session-789',
      completedAt: '2026-05-22T14:30:00.000Z',
      cost: 0.001,
    };

    // Should not throw
    await expect(writeLocalUsage(event)).resolves.toBeUndefined();

    // Reset for cleanup
    setLocalUsageDir(testDir);
  });

  it('logs write errors only when debug flag is set', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Set to an invalid directory
    setLocalUsageDir('/invalid/readonly/path');

    const event: LocalUsageEvent = {
      id: 'test-123',
      generationId: 'gen-456',
      sessionId: 'session-789',
      completedAt: '2026-05-22T14:30:00.000Z',
      cost: 0.001,
    };

    // Without debug flag - should be quiet
    clearEnv('PI_OPENROUTER_DEBUG_USAGE');
    await writeLocalUsage(event);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // With debug flag - should log
    setEnv('PI_OPENROUTER_DEBUG_USAGE', '1');
    await writeLocalUsage(event);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[local-usage]'),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();

    // Reset for cleanup
    setLocalUsageDir(testDir);
  });
});

// =============================================================================
// Read Functionality
// =============================================================================

describe('readLocalUsage', () => {
  it('reads events from single day file', async () => {
    const events: LocalUsageEvent[] = [
      {
        id: 'test-1',
        generationId: 'gen-1',
        sessionId: 'session-1',
        completedAt: '2026-05-22T10:00:00.000Z',
        cost: 0.001,
      },
      {
        id: 'test-2',
        generationId: 'gen-2',
        sessionId: 'session-2',
        completedAt: '2026-05-22T15:00:00.000Z',
        cost: 0.002,
      },
    ];

    const filePath = path.join(testDir, '2026-05-22.jsonl');
    const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(filePath, content, 'utf8');

    const result = await readLocalUsage({
      fromDateUtc: '2026-05-22',
      toDateUtc: '2026-05-22',
    });

    expect(result).toHaveLength(2);
    expect(result).toEqual(events);
  });

  it('reads events across multiple days', async () => {
    const event1: LocalUsageEvent = {
      id: 'test-1',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-20T10:00:00.000Z',
      cost: 0.001,
    };

    const event2: LocalUsageEvent = {
      id: 'test-2',
      generationId: 'gen-2',
      sessionId: 'session-2',
      completedAt: '2026-05-21T15:00:00.000Z',
      cost: 0.002,
    };

    const event3: LocalUsageEvent = {
      id: 'test-3',
      generationId: 'gen-3',
      sessionId: 'session-3',
      completedAt: '2026-05-22T20:00:00.000Z',
      cost: 0.003,
    };

    await fs.writeFile(
      path.join(testDir, '2026-05-20.jsonl'),
      JSON.stringify(event1) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(testDir, '2026-05-21.jsonl'),
      JSON.stringify(event2) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(testDir, '2026-05-22.jsonl'),
      JSON.stringify(event3) + '\n',
      'utf8',
    );

    const result = await readLocalUsage({
      fromDateUtc: '2026-05-20',
      toDateUtc: '2026-05-22',
    });

    expect(result).toHaveLength(3);
    expect(result).toEqual([event1, event2, event3]);
  });

  it('tolerates missing files in date range', async () => {
    const event1: LocalUsageEvent = {
      id: 'test-1',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-20T10:00:00.000Z',
      cost: 0.001,
    };

    // Only write day 20, skip day 21, will read 20-22
    await fs.writeFile(
      path.join(testDir, '2026-05-20.jsonl'),
      JSON.stringify(event1) + '\n',
      'utf8',
    );

    const result = await readLocalUsage({
      fromDateUtc: '2026-05-20',
      toDateUtc: '2026-05-22',
    });

    // Should get only the event from day 20
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(event1);
  });

  it('tolerates blank lines in files', async () => {
    const event: LocalUsageEvent = {
      id: 'test-1',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-22T10:00:00.000Z',
      cost: 0.001,
    };

    const content = `
${JSON.stringify(event)}


`;
    await fs.writeFile(path.join(testDir, '2026-05-22.jsonl'), content, 'utf8');

    const result = await readLocalUsage({
      fromDateUtc: '2026-05-22',
      toDateUtc: '2026-05-22',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(event);
  });

  it('tolerates malformed JSON lines and continues', async () => {
    const validEvent: LocalUsageEvent = {
      id: 'test-valid',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-22T10:00:00.000Z',
      cost: 0.001,
    };

    const content = `${JSON.stringify(validEvent)}
{invalid json}
${JSON.stringify(validEvent)}
`;
    await fs.writeFile(path.join(testDir, '2026-05-22.jsonl'), content, 'utf8');

    const result = await readLocalUsage({
      fromDateUtc: '2026-05-22',
      toDateUtc: '2026-05-22',
    });

    // Should get both valid events, skip malformed line
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(validEvent);
    expect(result[1]).toEqual(validEvent);
  });

  it('logs malformed lines only when debug flag is set', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const content = '{invalid json}\n';
    await fs.writeFile(path.join(testDir, '2026-05-22.jsonl'), content, 'utf8');

    // Without debug flag - should be quiet
    clearEnv('PI_OPENROUTER_DEBUG_USAGE');
    await readLocalUsage({
      fromDateUtc: '2026-05-22',
      toDateUtc: '2026-05-22',
    });
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    // With debug flag - should log
    setEnv('PI_OPENROUTER_DEBUG_USAGE', '1');
    await readLocalUsage({
      fromDateUtc: '2026-05-22',
      toDateUtc: '2026-05-22',
    });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[local-usage]'),
      expect.anything(),
    );

    consoleWarnSpy.mockRestore();
  });

  it('continues on read error for individual files', async () => {
    const event1: LocalUsageEvent = {
      id: 'test-1',
      generationId: 'gen-1',
      sessionId: 'session-1',
      completedAt: '2026-05-20T10:00:00.000Z',
      cost: 0.001,
    };

    await fs.writeFile(
      path.join(testDir, '2026-05-20.jsonl'),
      JSON.stringify(event1) + '\n',
      'utf8',
    );
    // Create an unreadable file for day 21 by creating it without read permissions
    const day21Path = path.join(testDir, '2026-05-21.jsonl');
    await fs.writeFile(day21Path, 'test\n', 'utf8');
    try {
      await fs.chmod(day21Path, 0o000);
    } catch {
      // If chmod fails (e.g., on some platforms), skip this test scenario
      // Just verify we can read day 20
    }

    const result = await readLocalUsage({
      fromDateUtc: '2026-05-20',
      toDateUtc: '2026-05-21',
    });

    // Should get at least event from day 20
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]).toEqual(event1);

    // Restore permissions for cleanup
    try {
      await fs.chmod(day21Path, 0o644);
    } catch {
      // Ignore
    }
  });
});

// =============================================================================
// Aggregation
// =============================================================================

describe('aggregateLocal', () => {
  it('returns zero aggregate for empty array', () => {
    const result = aggregateLocal([]);
    expect(result).toEqual({
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });
  });

  it('aggregates single event', () => {
    const events: LocalUsageEvent[] = [
      {
        id: 'test-1',
        generationId: 'gen-1',
        sessionId: 'session-1',
        completedAt: '2026-05-22T10:00:00.000Z',
        requests: 1,
        promptTokens: 100,
        completionTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        cost: 0.0025,
      },
    ];

    const result = aggregateLocal(events);
    expect(result).toEqual({
      requests: 1,
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      cost: 0.0025,
    });
  });

  it('aggregates multiple events', () => {
    const events: LocalUsageEvent[] = [
      {
        id: 'test-1',
        generationId: 'gen-1',
        sessionId: 'session-1',
        completedAt: '2026-05-22T10:00:00.000Z',
        requests: 1,
        promptTokens: 100,
        completionTokens: 50,
        cost: 0.0025,
      },
      {
        id: 'test-2',
        generationId: 'gen-2',
        sessionId: 'session-2',
        completedAt: '2026-05-22T15:00:00.000Z',
        requests: 1,
        promptTokens: 200,
        completionTokens: 100,
        cost: 0.005,
      },
    ];

    const result = aggregateLocal(events);
    expect(result).toEqual({
      requests: 2,
      promptTokens: 300,
      completionTokens: 150,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.0075,
    });
  });

  it('deduplicates by id, keeping first occurrence', () => {
    const events: LocalUsageEvent[] = [
      {
        id: 'duplicate-id',
        generationId: 'gen-1',
        sessionId: 'session-1',
        completedAt: '2026-05-22T10:00:00.000Z',
        requests: 1,
        promptTokens: 100,
        cost: 0.001,
      },
      {
        id: 'duplicate-id', // Same ID
        generationId: 'gen-2',
        sessionId: 'session-2',
        completedAt: '2026-05-22T11:00:00.000Z',
        requests: 1,
        promptTokens: 999, // Different values
        cost: 0.999,
      },
      {
        id: 'unique-id',
        generationId: 'gen-3',
        sessionId: 'session-3',
        completedAt: '2026-05-22T12:00:00.000Z',
        requests: 1,
        promptTokens: 50,
        cost: 0.002,
      },
    ];

    const result = aggregateLocal(events);

    // Should only count first occurrence of 'duplicate-id' + 'unique-id'
    expect(result).toEqual({
      requests: 2,
      promptTokens: 150, // 100 (first duplicate) + 50 (unique)
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.003, // 0.001 + 0.002
    });
  });

  it('handles missing optional fields as zero', () => {
    const events: LocalUsageEvent[] = [
      {
        id: 'test-1',
        generationId: 'gen-1',
        sessionId: 'session-1',
        completedAt: '2026-05-22T10:00:00.000Z',
        // No requests, tokens, or cost fields
      },
    ];

    const result = aggregateLocal(events);
    expect(result.requests).toBe(1); // requests defaults to 1
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.cost).toBe(0);
  });
});

// =============================================================================
// Retention Cleanup
// =============================================================================

describe('cleanupOldUsageFiles', () => {
  it('deletes files older than retention window', async () => {
    // Create files spanning different ages
    const today = getCurrentUtcDate();
    const day30 = addUtcDays(today, -30);
    const day60 = addUtcDays(today, -60);
    const day90 = addUtcDays(today, -90);
    const day120 = addUtcDays(today, -120);

    await fs.writeFile(path.join(testDir, `${today}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${day30}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${day60}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${day90}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${day120}.jsonl`), 'test\n', 'utf8');

    // Cleanup with 90-day retention
    await cleanupOldUsageFiles({ retentionDays: 90 });

    // Check which files remain
    const files = await fs.readdir(testDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

    // Should keep today, day30, day60, day90; delete day120
    expect(jsonlFiles).toContain(`${today}.jsonl`);
    expect(jsonlFiles).toContain(`${day30}.jsonl`);
    expect(jsonlFiles).toContain(`${day60}.jsonl`);
    expect(jsonlFiles).toContain(`${day90}.jsonl`); // Exactly on boundary - kept
    expect(jsonlFiles).not.toContain(`${day120}.jsonl`); // Too old - deleted
  });

  it('uses default 90-day retention when not specified', async () => {
    const today = getCurrentUtcDate();
    const day91 = addUtcDays(today, -91);

    await fs.writeFile(path.join(testDir, `${today}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${day91}.jsonl`), 'test\n', 'utf8');

    await cleanupOldUsageFiles();

    const files = await fs.readdir(testDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

    expect(jsonlFiles).toContain(`${today}.jsonl`);
    expect(jsonlFiles).not.toContain(`${day91}.jsonl`);
  });

  it('skips non-JSONL files', async () => {
    await fs.writeFile(path.join(testDir, 'other.txt'), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, 'README.md'), 'test\n', 'utf8');

    await cleanupOldUsageFiles({ retentionDays: 1 });

    const files = await fs.readdir(testDir);
    expect(files).toContain('other.txt');
    expect(files).toContain('README.md');
  });

  it('skips malformed filename dates', async () => {
    const today = getCurrentUtcDate();
    await fs.writeFile(path.join(testDir, `${today}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, 'invalid-date.jsonl'), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, '2026-13-99.jsonl'), 'test\n', 'utf8'); // Invalid date

    await cleanupOldUsageFiles({ retentionDays: 1 });

    const files = await fs.readdir(testDir);
    expect(files).toContain(`${today}.jsonl`);
    // Malformed files should be skipped, not deleted
    expect(files).toContain('invalid-date.jsonl');
    expect(files).toContain('2026-13-99.jsonl');
  });

  it('fails open on directory read error', async () => {
    // Set to a non-existent directory
    setLocalUsageDir('/nonexistent/directory');

    // Should not throw
    await expect(cleanupOldUsageFiles()).resolves.toBeUndefined();

    // Reset for cleanup
    setLocalUsageDir(testDir);
  });

  it('fails open on individual file delete error', async () => {
    const old = addUtcDays(getCurrentUtcDate(), -120);
    const oldPath = path.join(testDir, `${old}.jsonl`);
    await fs.writeFile(oldPath, 'test\n', 'utf8');

    // Make the file undeletable by removing write permissions from directory
    try {
      await fs.chmod(testDir, 0o555);

      // Should not throw even if delete fails
      await expect(cleanupOldUsageFiles({ retentionDays: 90 })).resolves.toBeUndefined();

      // Restore permissions
      await fs.chmod(testDir, 0o755);
    } catch {
      // If chmod fails, just verify cleanup doesn't throw on any error
      await expect(cleanupOldUsageFiles({ retentionDays: 90 })).resolves.toBeUndefined();

      // Try to restore
      try {
        await fs.chmod(testDir, 0o755);
      } catch {
        // Ignore
      }
    }
  });

  it('logs cleanup errors only when debug flag is set', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Set to a non-existent directory
    setLocalUsageDir('/nonexistent/directory');

    // Without debug flag - should be quiet
    clearEnv('PI_OPENROUTER_DEBUG_USAGE');
    await cleanupOldUsageFiles();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // With debug flag - should log
    setEnv('PI_OPENROUTER_DEBUG_USAGE', '1');
    await cleanupOldUsageFiles();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[local-usage]'),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();

    // Reset for cleanup
    setLocalUsageDir(testDir);
  });

  it('logs deleted file count when debug flag is set', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const old1 = addUtcDays(getCurrentUtcDate(), -120);
    const old2 = addUtcDays(getCurrentUtcDate(), -121);
    await fs.writeFile(path.join(testDir, `${old1}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${old2}.jsonl`), 'test\n', 'utf8');

    // Without debug flag - should be quiet
    clearEnv('PI_OPENROUTER_DEBUG_USAGE');
    await cleanupOldUsageFiles({ retentionDays: 90 });
    expect(consoleLogSpy).not.toHaveBeenCalled();

    // Recreate files
    await fs.writeFile(path.join(testDir, `${old1}.jsonl`), 'test\n', 'utf8');
    await fs.writeFile(path.join(testDir, `${old2}.jsonl`), 'test\n', 'utf8');

    // With debug flag - should log count
    setEnv('PI_OPENROUTER_DEBUG_USAGE', '1');
    await cleanupOldUsageFiles({ retentionDays: 90 });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[local-usage\].*2 old.*file/),
    );

    consoleLogSpy.mockRestore();
  });
});
