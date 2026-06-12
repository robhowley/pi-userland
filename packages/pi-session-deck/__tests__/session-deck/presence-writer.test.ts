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
  it('creates the presence directory and writes a canonical record file', async () => {
    const directory = await createPresenceDirectory();
    const record = buildRecord();

    const targetPath = await writePresenceRecord(record, {
      directory: join(directory, 'presence'),
    });
    const written = JSON.parse(await readFile(targetPath, 'utf8')) as PresenceRecord;

    expect(written).toEqual(record);
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
});
