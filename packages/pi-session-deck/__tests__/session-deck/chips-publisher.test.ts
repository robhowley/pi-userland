import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSessionDeckChip,
  publishSessionDeckChip,
} from '../../extensions/session-deck/chips/publisher.js';
import {
  getPresenceRuntimeIdentity,
  resetPresenceRuntimeForTests,
} from '../../extensions/session-deck/presence/runtime.js';

const createdDirectories: string[] = [];

async function createTestDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-deck-publisher-'));
  createdDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  await resetPresenceRuntimeForTests();
  await Promise.all(
    createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('publishSessionDeckChip', () => {
  it('defaults runtimeId from presence runtime identity and sessionId from sessionManager', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];
    const runtime = getPresenceRuntimeIdentity();

    const result = await publishSessionDeckChip(
      {
        source: 'pi-session-hygiene',
        text: 'Session healthy',
        level: 'ok',
      },
      {
        directory: dir,
        sessionManager: {
          getSessionId: () => 'session-1',
        },
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).not.toBeNull();
    expect(diagnostics).toEqual([]);

    const file = join(dir, runtime.runtimeId, 'pi-session-hygiene.default.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(record['runtimeId']).toBe(runtime.runtimeId);
    expect(record['sessionId']).toBe('session-1');
    expect(record['scope']).toBe('session');
  });

  it('rejects session-scoped publish without a resolved sessionId', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];

    const result = await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'test',
        level: 'ok',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_session_id_missing');
  });

  it('rejects empty text', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];

    const result = await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: '',
        level: 'ok',
        scope: 'runtime',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_text_empty');
  });

  it('rejects invalid source slug', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];

    const result = await publishSessionDeckChip(
      {
        source: 'not/a/slug',
        text: 'test',
        level: 'ok',
        scope: 'runtime',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_source_invalid');
  });

  it('rejects missing source', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];

    const result = await publishSessionDeckChip(
      {
        source: '',
        text: 'test',
        level: 'ok',
        scope: 'runtime',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_source_invalid');
  });

  it('coerces invalid level to unknown', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];
    const runtime = getPresenceRuntimeIdentity();

    const result = await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'test',
        level: 'invalid' as 'ok',
        scope: 'runtime',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).not.toBeNull();
    expect(diagnostics).toContain('chip_level_invalid');

    const file = join(dir, runtime.runtimeId, 'pi-test.default.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(record['level']).toBe('unknown');
  });

  it('rejects invalid scope', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];

    const result = await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'test',
        level: 'ok',
        scope: 'invalid' as 'session',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_scope_invalid');
  });

  it('rejects future timestamps beyond skew', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];
    const future = new Date(Date.now() + 60_000).toISOString();

    const result = await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'test',
        level: 'ok',
        updatedAt: future,
        scope: 'runtime',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).toBeNull();
    expect(diagnostics).toContain('chip_updated_at_future');
  });

  it('publishes runtime-scoped chip', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];
    const runtime = getPresenceRuntimeIdentity();

    const result = await publishSessionDeckChip(
      {
        source: 'pi-openrouter',
        text: 'OR Status: $0.00',
        level: 'ok',
        scope: 'runtime',
      },
      {
        directory: dir,
        onDiagnostic: (code) => diagnostics.push(code),
      },
    );

    expect(result).not.toBeNull();
    const file = join(dir, runtime.runtimeId, 'pi-openrouter.default.json');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(record['scope']).toBe('runtime');
    expect(record['sessionId']).toBeNull();
  });
});

describe('clearSessionDeckChip', () => {
  it('clears an existing chip file using the default runtimeId', async () => {
    const dir = await createTestDir();
    const runtime = getPresenceRuntimeIdentity();

    await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'test',
        level: 'ok',
        scope: 'runtime',
      },
      { directory: dir },
    );

    const cleared = await clearSessionDeckChip(
      { source: 'pi-test', scope: 'runtime' },
      { directory: dir },
    );

    expect(cleared).toBe(true);
    expect(await readdir(join(dir, runtime.runtimeId))).toEqual([]);
  });

  it('returns false for missing files (not an error)', async () => {
    const dir = await createTestDir();
    const diagnostics: string[] = [];

    const cleared = await clearSessionDeckChip(
      { source: 'pi-nonexistent', scope: 'runtime' },
      { directory: dir, onDiagnostic: (code) => diagnostics.push(code) },
    );

    expect(cleared).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('clears by specific chipId', async () => {
    const dir = await createTestDir();
    const runtime = getPresenceRuntimeIdentity();

    await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'main',
        level: 'ok',
        chipId: 'a',
        scope: 'runtime',
      },
      { directory: dir },
    );
    await publishSessionDeckChip(
      {
        source: 'pi-test',
        text: 'other',
        level: 'ok',
        chipId: 'b',
        scope: 'runtime',
      },
      { directory: dir },
    );

    const cleared = await clearSessionDeckChip(
      { source: 'pi-test', chipId: 'a', scope: 'runtime' },
      { directory: dir },
    );

    expect(cleared).toBe(true);
    const fileNames = (await readdir(join(dir, runtime.runtimeId))).sort();
    expect(fileNames).toEqual(['pi-test.b.json']);
  });
});
