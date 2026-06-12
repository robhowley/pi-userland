import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePresenceRecord } from '../../extensions/session-deck/presence/writer.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const createdDirectories: string[] = [];

function buildRecord(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    runtimeId: 'runtime-1',
    pid: 1234,
    startedAt: '2026-06-12T11:55:00.000Z',
    heartbeatAt: '2026-06-12T11:59:55.000Z',
    ...overrides,
  };
}

async function createPresenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-deck-writer-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('writePresenceRecord', () => {
  it('creates the presence directory and writes a canonical four-field record file', async () => {
    const directory = await createPresenceDirectory();
    const record = buildRecord();

    const targetPath = await writePresenceRecord(record, {
      directory: join(directory, 'presence'),
    });
    const written = JSON.parse(await readFile(targetPath, 'utf8')) as Record<string, unknown>;

    expect(written).toEqual(record);
    expect(Object.keys(written)).toEqual(['runtimeId', 'pid', 'startedAt', 'heartbeatAt']);
  });

  it('overwrites one runtime file without leaving temp files behind', async () => {
    const directory = await createPresenceDirectory();
    const record = buildRecord();
    const updated = buildRecord({ heartbeatAt: '2026-06-12T12:00:05.000Z' });

    await writePresenceRecord(record, { directory });
    const targetPath = await writePresenceRecord(updated, { directory });

    const written = JSON.parse(await readFile(targetPath, 'utf8')) as PresenceRecord;
    expect(written).toEqual(updated);

    const fileNames = (await readdir(directory)).sort();
    expect(fileNames).toEqual(['runtime-1.json']);
  });

  it('keeps shared state valid for three concurrent runtime writers', async () => {
    const directory = await createPresenceDirectory();
    const records = [
      buildRecord({ runtimeId: 'runtime-1', pid: 1001 }),
      buildRecord({ runtimeId: 'runtime-2', pid: 1002 }),
      buildRecord({ runtimeId: 'runtime-3', pid: 1003 }),
    ];

    await Promise.all(records.map((record) => writePresenceRecord(record, { directory })));

    const fileNames = (await readdir(directory)).sort();
    expect(fileNames).toEqual(['runtime-1.json', 'runtime-2.json', 'runtime-3.json']);

    const writtenRecords = await Promise.all(
      fileNames.map(
        async (fileName) =>
          JSON.parse(await readFile(join(directory, fileName), 'utf8')) as PresenceRecord,
      ),
    );
    expect(writtenRecords).toEqual(records);
  });
});
