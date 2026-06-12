import type { Dirent } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPresenceView } from '../../extensions/session-deck/presence/reader.js';
import { reapPresenceRecords } from '../../extensions/session-deck/presence/reap.js';
import type { PresenceRecord } from '../../extensions/session-deck/presence/types.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const createdDirectories: string[] = [];

function buildRecord(runtimeId: string, heartbeatAt: string): PresenceRecord {
  return {
    runtimeId,
    pid: 1234,
    startedAt: '2026-06-12T11:55:00.000Z',
    heartbeatAt,
  };
}

async function createPresenceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-deck-reap-'));
  createdDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeRecord(directory: string, record: PresenceRecord): Promise<void> {
  await writeFile(join(directory, `${record.runtimeId}.json`), JSON.stringify(record), 'utf8');
}

function createFileDirent(name: string): Dirent<string> {
  return {
    name,
    isFile: () => true,
  } as Dirent<string>;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('presence reaping', () => {
  it('keeps stale records visible during normal reads and before reapAfter', async () => {
    const directory = await createPresenceDirectory();
    await writeRecord(directory, buildRecord('stale-runtime', '2026-06-12T11:59:20.000Z'));

    const view = await readPresenceView({
      directory,
      now: NOW,
      inspectPid: async () => ({ status: 'matches' }),
    });

    expect(view.records.map((record) => [record.runtimeId, record.presenceState])).toEqual([
      ['stale-runtime', 'stale'],
    ]);
    expect(await readdir(directory)).toEqual(['stale-runtime.json']);

    const reapResult = await reapPresenceRecords({ directory, now: NOW });

    expect(reapResult.removed).toEqual([]);
    expect(await readdir(directory)).toEqual(['stale-runtime.json']);
  });

  it('reaps old records only after reapAfter', async () => {
    const directory = await createPresenceDirectory();
    await writeRecord(directory, buildRecord('old-runtime', '2026-06-10T11:59:55.000Z'));

    const reapResult = await reapPresenceRecords({
      directory,
      now: new Date('2026-06-12T12:00:00.000Z'),
    });

    expect(reapResult.removed).toEqual([join(directory, 'old-runtime.json')]);
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports write diagnostics when removing an expired record fails', async () => {
    const directory = '/tmp/session-deck';
    const filePath = join(directory, 'old-runtime.json');
    const unlink = vi.fn(async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    const reapResult = await reapPresenceRecords({
      directory,
      now: NOW,
      readdir: async () => [createFileDirent('old-runtime.json')],
      readFile: async () => JSON.stringify(buildRecord('old-runtime', '2026-06-10T11:59:55.000Z')),
      unlink,
    });

    expect(unlink).toHaveBeenCalledWith(filePath);
    expect(reapResult.removed).toEqual([]);
    expect(reapResult.diagnostics).toEqual([
      {
        code: 'write_error',
        filePath,
        message: 'Failed to reap presence record: permission denied',
      },
    ]);
  });
});
