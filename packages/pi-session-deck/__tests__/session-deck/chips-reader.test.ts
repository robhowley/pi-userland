import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSessionDeckChips } from '../../extensions/session-deck/chips/reader.js';
import type { SessionDeckChipRecord } from '../../extensions/session-deck/chips/types.js';
import { writeChipRecord } from '../../extensions/session-deck/chips/writer.js';

const createdDirectories: string[] = [];

function buildChipRecord(overrides: Partial<SessionDeckChipRecord> = {}): SessionDeckChipRecord {
  return {
    schemaVersion: 1,
    runtimeId: 'rt-1',
    sessionId: 'session-1',
    source: 'alpha',
    chipId: 'default',
    scope: 'session',
    text: 'session ready',
    level: 'ok',
    updatedAt: '2026-06-23T12:09:30.000Z',
    ...overrides,
  };
}

function buildTarget(
  overrides: Partial<{
    runtimeId: string;
    sessionId: string | null;
    sessionIdTrusted: boolean;
  }> = {},
) {
  return {
    runtimeId: 'rt-1',
    sessionId: 'session-1',
    sessionIdTrusted: true,
    ...overrides,
  };
}

async function createChipsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-deck-chip-reader-'));
  createdDirectories.push(directory);
  return directory;
}

function fileDirent(name: string): Dirent<string> {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
  } as unknown as Dirent<string>;
}

function directoryDirent(name: string): Dirent<string> {
  return {
    name,
    isFile: () => false,
    isDirectory: () => true,
  } as unknown as Dirent<string>;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session-deck chip reader', () => {
  it('reads a runtime-scoped chip and ignores temp and non-record files', async () => {
    const directory = await createChipsDirectory();
    const runtimeDirectory = join(directory, 'rt-1');

    await writeChipRecord(
      buildChipRecord({
        source: 'runtime',
        scope: 'runtime',
        sessionId: null,
        text: 'runtime ready',
      }),
      { directory },
    );
    await mkdir(join(runtimeDirectory, 'nested'), { recursive: true });
    await writeFile(join(runtimeDirectory, '.runtime.default.runtime.mock.tmp'), 'tmp', 'utf8');
    await writeFile(join(runtimeDirectory, 'notes.txt'), 'ignored', 'utf8');

    const view = await readSessionDeckChips({
      records: [buildTarget()],
      chipsDirectory: directory,
      now: new Date('2026-06-23T12:10:00.000Z'),
    });

    expect(view.records).toEqual([
      {
        runtimeId: 'rt-1',
        chips: ['runtime ready'],
        diagnostics: [],
      },
    ]);
    expect(view.diagnostics).toEqual([]);
  });

  it('reads a session-scoped chip for the current sessionId', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(buildChipRecord({ text: 'session healthy' }), { directory });

    const view = await readSessionDeckChips({
      records: [buildTarget()],
      chipsDirectory: directory,
      now: new Date('2026-06-23T12:10:00.000Z'),
    });

    expect(view.records[0]?.chips).toEqual(['session healthy']);
    expect(view.records[0]?.diagnostics).toEqual([]);
  });

  it('suppresses old-session chips but keeps runtime-scoped chips across session changes', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(
      buildChipRecord({
        source: 'session',
        sessionId: 'session-old',
        text: 'old session',
      }),
      { directory },
    );
    await writeChipRecord(
      buildChipRecord({
        source: 'runtime',
        scope: 'runtime',
        sessionId: null,
        text: 'runtime survives',
      }),
      { directory },
    );

    const view = await readSessionDeckChips({
      records: [buildTarget({ sessionId: 'session-new' })],
      chipsDirectory: directory,
      now: new Date('2026-06-23T12:10:00.000Z'),
    });

    expect(view.records[0]?.chips).toEqual(['runtime survives']);
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'chip_session_mismatch',
    ]);
    expect(view.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'chip_session_mismatch',
    ]);
  });

  it('omits expired chips and reports chip_expired', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(
      buildChipRecord({
        source: 'runtime',
        scope: 'runtime',
        sessionId: null,
        text: 'expired',
        updatedAt: '2026-06-23T12:00:00.000Z',
        ttlMs: 30_000,
      }),
      { directory },
    );

    const view = await readSessionDeckChips({
      records: [buildTarget()],
      chipsDirectory: directory,
      now: new Date('2026-06-23T12:01:00.000Z'),
    });

    expect(view.records[0]?.chips).toEqual([]);
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'chip_expired',
    ]);
    expect(view.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['chip_expired']);
  });

  it('surfaces malformed JSON, malformed records, and unreadable files without dropping good chips', async () => {
    const chipsDirectory = '/virtual/chips';
    const runtimeDirectory = join(chipsDirectory, 'rt-1');
    const readdir = vi.fn(async (path: string) => {
      if (path === chipsDirectory) {
        return [directoryDirent('rt-1')];
      }

      if (path === runtimeDirectory) {
        return [
          fileDirent('bad-json.default.runtime.json'),
          fileDirent('bad-record.default.runtime.json'),
          fileDirent('good.default.runtime.json'),
          fileDirent('unreadable.default.runtime.json'),
        ];
      }

      return [];
    });
    const readFile = vi.fn(async (path: string) => {
      switch (path) {
        case join(runtimeDirectory, 'bad-json.default.runtime.json'):
          return 'not json';
        case join(runtimeDirectory, 'bad-record.default.runtime.json'):
          return JSON.stringify({ schemaVersion: 1 });
        case join(runtimeDirectory, 'good.default.runtime.json'):
          return JSON.stringify(
            buildChipRecord({
              scope: 'runtime',
              sessionId: null,
              source: 'good',
              text: 'good chip',
            }),
          );
        case join(runtimeDirectory, 'unreadable.default.runtime.json'):
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        default:
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    });

    const view = await readSessionDeckChips({
      records: [buildTarget()],
      chipsDirectory,
      now: new Date('2026-06-23T12:10:00.000Z'),
      readdir,
      readFile,
    });

    expect(view.records[0]?.chips).toEqual(['good chip']);
    expect(view.records[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'malformed_chip_record',
      'malformed_chip_record',
      'chip_read_error',
    ]);
    expect(view.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'malformed_chip_record',
      'malformed_chip_record',
      'chip_read_error',
    ]);
  });

  it('reports orphan chips for runtimes with no matching row', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(
      buildChipRecord({
        runtimeId: 'rt-orphan',
        source: 'orphan',
        scope: 'runtime',
        sessionId: null,
        text: 'orphan chip',
      }),
      { directory },
    );

    const view = await readSessionDeckChips({
      records: [],
      chipsDirectory: directory,
      now: new Date('2026-06-23T12:10:00.000Z'),
    });

    expect(view.records).toEqual([]);
    expect(view.diagnostics).toEqual([
      {
        code: 'orphan_chip',
        message: 'Chip record has no matching runtime row',
        runtimeId: 'rt-orphan',
      },
    ]);
  });
});
