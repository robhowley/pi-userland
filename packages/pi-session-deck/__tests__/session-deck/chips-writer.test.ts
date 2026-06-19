import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearChipRecord,
  serializeChipRecord,
  writeChipRecord,
} from '../../extensions/session-deck/chips/writer.js';
import type { SessionDeckChipRecord } from '../../extensions/session-deck/chips/types.js';

const createdDirectories: string[] = [];

function buildRecord(overrides: Partial<SessionDeckChipRecord> = {}): SessionDeckChipRecord {
  return {
    schemaVersion: 1,
    runtimeId: 'rt-abc',
    sessionId: 'session-1',
    source: 'pi-merge-ready',
    chipId: 'default',
    scope: 'session',
    text: 'Ready to merge',
    level: 'ok',
    updatedAt: '2026-06-17T12:00:00.000Z',
    ...overrides,
  };
}

async function createChipsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-session-deck-chips-'));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('serializeChipRecord', () => {
  it('serializes a complete record to JSON', () => {
    const json = serializeChipRecord(buildRecord());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBe(1);
    expect(parsed['source']).toBe('pi-merge-ready');
    expect(parsed['text']).toBe('Ready to merge');
    expect(parsed['level']).toBe('ok');
  });

  it('includes optional ttlMs when present', () => {
    const json = serializeChipRecord(buildRecord({ ttlMs: 120_000 }));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['ttlMs']).toBe(120_000);
  });

  it('omits ttlMs when undefined', () => {
    const json = serializeChipRecord(buildRecord());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['ttlMs']).toBeUndefined();
  });
});

describe('writeChipRecord', () => {
  it('creates the runtime directory and writes a chip record file', async () => {
    const directory = await createChipsDirectory();

    const targetPath = await writeChipRecord(buildRecord(), { directory });
    expect(targetPath).not.toBeNull();
    const written = JSON.parse(await readFile(targetPath!, 'utf8')) as Record<string, unknown>;

    expect(written['runtimeId']).toBe('rt-abc');
    expect(written['source']).toBe('pi-merge-ready');
    expect(written['chipId']).toBe('default');
    expect(written['sessionId']).toBe('session-1');
  });

  it('overwrites one chip file without leaving temp files behind', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(buildRecord(), { directory });
    const targetPath = await writeChipRecord(buildRecord({ text: 'Updated status' }), {
      directory,
    });
    expect(targetPath).not.toBeNull();

    const written = JSON.parse(await readFile(targetPath!, 'utf8')) as Record<string, unknown>;
    expect(written['text']).toBe('Updated status');

    const runtimeDir = join(directory, 'rt-abc');
    const fileNames = (await readdir(runtimeDir)).sort();
    expect(fileNames).toEqual(['pi-merge-ready.default.session.json']);
  });

  it('writes different chip IDs as separate files', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(buildRecord({ chipId: 'current-pr', text: 'PR status' }), { directory });
    await writeChipRecord(
      buildRecord({
        chipId: 'health',
        text: 'Session healthy',
        source: 'pi-session-hygiene',
      }),
      { directory },
    );

    const runtimeDir = join(directory, 'rt-abc');
    const fileNames = (await readdir(runtimeDir)).sort();
    expect(fileNames).toEqual([
      'pi-merge-ready.current-pr.session.json',
      'pi-session-hygiene.health.session.json',
    ]);
  });

  it('keeps session-scoped and runtime-scoped chips with the same source and chipId', async () => {
    const directory = await createChipsDirectory();

    await writeChipRecord(buildRecord({ chipId: 'status', text: 'Session status' }), { directory });
    await writeChipRecord(
      buildRecord({
        chipId: 'status',
        scope: 'runtime',
        sessionId: null,
        text: 'Runtime status',
      }),
      { directory },
    );

    const runtimeDir = join(directory, 'rt-abc');
    const fileNames = (await readdir(runtimeDir)).sort();
    expect(fileNames).toEqual([
      'pi-merge-ready.status.runtime.json',
      'pi-merge-ready.status.session.json',
    ]);
  });

  it('fails gracefully when mkdir fails', async () => {
    const diagnostics: string[] = [];
    const mkdir = vi.fn().mockRejectedValue(new Error('permission denied'));

    const result = await writeChipRecord(buildRecord(), {
      directory: '/invalid-path',
      mkdir,
      onDiagnostic: (code) => diagnostics.push(code),
    });

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_write_error');
  });

  it('supports runtime-scoped records', async () => {
    const directory = await createChipsDirectory();

    const targetPath = await writeChipRecord(
      buildRecord({
        scope: 'runtime',
        sessionId: null,
        chipId: 'status',
      }),
      { directory },
    );
    expect(targetPath).not.toBeNull();

    const written = JSON.parse(await readFile(targetPath!, 'utf8')) as Record<string, unknown>;
    expect(written['scope']).toBe('runtime');
    expect(written['sessionId']).toBeNull();
  });

  it('rejects session-scoped records without a resolved sessionId', async () => {
    const diagnostics: string[] = [];

    const result = await writeChipRecord(buildRecord({ sessionId: null }), {
      onDiagnostic: (code) => diagnostics.push(code),
    });

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_session_id_missing');
  });
});

describe('clearChipRecord', () => {
  it('removes only the requested scoped chip file', async () => {
    const directory = await createChipsDirectory();
    await writeChipRecord(buildRecord({ chipId: 'default' }), { directory });
    await writeChipRecord(
      buildRecord({ chipId: 'default', scope: 'runtime', sessionId: null, text: 'runtime' }),
      { directory },
    );

    const cleared = await clearChipRecord(
      {
        source: 'pi-merge-ready',
        chipId: 'default',
        scope: 'runtime',
        runtimeId: 'rt-abc',
      },
      { directory },
    );

    expect(cleared).toBe(true);
    expect((await readdir(join(directory, 'rt-abc'))).sort()).toEqual([
      'pi-merge-ready.default.session.json',
    ]);
  });

  it('uses shared diagnostics for invalid clear keys', async () => {
    const diagnostics: string[] = [];

    const cleared = await clearChipRecord(
      {
        source: 'pi-merge-ready',
        runtimeId: '',
      },
      { onDiagnostic: (code) => diagnostics.push(code) },
    );

    expect(cleared).toBe(false);
    expect(diagnostics).toEqual(['chip_runtime_id_missing']);
  });
});
