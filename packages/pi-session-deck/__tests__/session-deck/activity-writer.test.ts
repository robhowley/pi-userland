import { describe, expect, it, vi } from 'vitest';
import type { SessionActivityRecord } from '../../extensions/session-deck/activity/types.js';

function buildRecord(overrides: Partial<SessionActivityRecord> = {}): SessionActivityRecord {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-abc',
    activityState: 'tool-running',
    idle: false,
    busy: true,
    currentTurnStartedAt: '2026-06-17T12:00:00.000Z',
    currentToolName: 'read',
    lastEventAt: '2026-06-17T12:00:42.000Z',
    lastError: null,
    lastToolStartedAt: '2026-06-17T12:00:42.000Z',
    activityUpdatedAt: '2026-06-17T12:00:42.000Z',
    activitySource: 'tool_start',
    ...overrides,
  };
}

describe('activity writer', () => {
  it('serializes a complete activity record to JSON', async () => {
    const { serializeActivityRecord } =
      await import('../../extensions/session-deck/activity/writer.js');

    const parsed = JSON.parse(serializeActivityRecord(buildRecord())) as SessionActivityRecord;
    expect(parsed.runtimeId).toBe('rt-1');
    expect(parsed.sessionId).toBe('session-abc');
    expect(parsed.activityState).toBe('tool-running');
    expect(parsed.currentToolName).toBe('read');
    expect(parsed.activitySource).toBe('tool_start');
  });

  it('serializes nullable fields correctly', async () => {
    const { serializeActivityRecord } =
      await import('../../extensions/session-deck/activity/writer.js');

    const parsed = JSON.parse(
      serializeActivityRecord(
        buildRecord({
          sessionId: null,
          activityState: 'waiting',
          idle: true,
          busy: false,
          currentTurnStartedAt: null,
          currentToolName: null,
          lastEventAt: '2026-06-17T12:05:00.000Z',
          lastError: null,
          activitySource: 'new',
        }),
      ),
    ) as SessionActivityRecord;

    expect(parsed.sessionId).toBeNull();
    expect(parsed.currentTurnStartedAt).toBeNull();
    expect(parsed.currentToolName).toBeNull();
    expect(parsed.activityState).toBe('waiting');
    expect(parsed.activitySource).toBe('new');
  });

  it('writes activity record atomically (temp + rename)', async () => {
    const { writeActivityRecord } =
      await import('../../extensions/session-deck/activity/writer.js');

    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const createTempPath = vi.fn().mockReturnValue('/tmp/.dir/rt-1.mock-temp.tmp');

    const path = await writeActivityRecord(buildRecord(), {
      directory: '/tmp/.dir',
      mkdir,
      writeFile,
      rename,
      createTempPath,
    });

    expect(path).toBe('/tmp/.dir/rt-1.json');
    expect(mkdir).toHaveBeenCalledWith('/tmp/.dir', { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('/tmp/.dir/rt-1.mock-temp.tmp', '/tmp/.dir/rt-1.json');
  });
});
