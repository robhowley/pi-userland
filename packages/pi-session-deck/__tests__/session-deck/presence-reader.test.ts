import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPresenceView } from '../../extensions/session-deck/presence/reader.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const createdDirectories: string[] = [];

function buildRecord(runtimeId: string, heartbeatAt: string, pid = 1234): PresenceRecord {
  return {
    runtimeId,
    pid,
    startedAt: '2026-06-12T11:55:00.000Z',
    heartbeatAt,
  };
}

async function createPresenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-deck-reader-'));
  createdDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeRecord(directory: string, record: PresenceRecord): Promise<void> {
  await writeFile(join(directory, `${record.runtimeId}.json`), JSON.stringify(record), 'utf8');
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('readPresenceView', () => {
  it('returns an empty list when the presence directory is missing', async () => {
    const view = await readPresenceView({
      directory: join(tmpdir(), `pi-session-deck-missing-directory-${randomUUID()}`),
      now: NOW,
      inspectPid: async () => ({ status: 'matches' }),
    });

    expect(view).toEqual({ records: [], diagnostics: [] });
  });

  it('ignores malformed files and reports diagnostics', async () => {
    const directory = await createPresenceDirectory();
    await writeRecord(directory, buildRecord('valid-runtime', '2026-06-12T11:59:55.000Z'));
    await writeFile(join(directory, 'broken.json'), '{"runtimeId":', 'utf8');
    await writeFile(
      join(directory, 'shape.json'),
      JSON.stringify({ runtimeId: 'shape-only' }),
      'utf8',
    );

    const view = await readPresenceView({
      directory,
      now: NOW,
      inspectPid: async () => ({ status: 'matches' }),
    });

    expect(view.records).toHaveLength(1);
    expect(view.records[0]?.runtimeId).toBe('valid-runtime');
    expect(view.diagnostics).toHaveLength(2);
    expect(view.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'malformed_record',
      'malformed_record',
    ]);
  });

  it('classifies and sorts live, stale, and dead records by heartbeat recency', async () => {
    const directory = await createPresenceDirectory();
    await writeRecord(directory, buildRecord('stale-runtime', '2026-06-12T11:59:20.000Z'));
    await writeRecord(directory, buildRecord('dead-runtime', '2026-06-12T11:49:00.000Z'));
    await writeRecord(directory, buildRecord('live-runtime', '2026-06-12T11:59:55.000Z'));

    const view = await readPresenceView({
      directory,
      now: NOW,
      inspectPid: async (record) => {
        if (record.runtimeId === 'dead-runtime') {
          return { status: 'matches' as const };
        }

        return { status: 'matches' as const };
      },
    });

    expect(view.records.map((record) => [record.runtimeId, record.presenceState])).toEqual([
      ['live-runtime', 'live'],
      ['stale-runtime', 'stale'],
      ['dead-runtime', 'dead'],
    ]);
    expect(view.records.map((record) => record.heartbeatAgeMs)).toEqual([5_000, 40_000, 660_000]);
  });

  it('surfaces pid reuse through the reader when pid validation proves it', async () => {
    const directory = await createPresenceDirectory();
    await writeRecord(directory, buildRecord('reused-runtime', '2026-06-12T11:59:55.000Z'));

    const view = await readPresenceView({
      directory,
      now: NOW,
      inspectPid: async () => ({ status: 'reused', reason: 'pid_reused' }),
    });

    expect(view.records).toHaveLength(1);
    expect(view.records[0]?.presenceState).toBe('dead');
    expect(view.records[0]?.reason).toBe('pid_reused');
  });
});
