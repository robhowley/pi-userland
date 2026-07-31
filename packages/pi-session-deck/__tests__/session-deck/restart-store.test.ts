import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getIdentityRecordPath } from '../../extensions/session-deck/identity/store.js';
import { readRestartRecoveryRecords } from '../../extensions/session-deck/restart/recovery.js';
import type {
  ManagedRestartRecipeV1,
  RestartJournalV1,
} from '../../extensions/session-deck/restart/types.js';
import {
  createRestartGeneration,
  getRestartJournalPath,
  getRestartRecipePath,
  normalizeRestartSessionRequest,
  readRestartJournal,
  readRestartRecipe,
  writeRestartJournal,
  writeRestartRecipe,
} from '../../extensions/session-deck/restart/store.js';

const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';

function recipe() {
  return {
    schemaVersion: 1 as const,
    runtimeId: RUNTIME_ID,
    launch: {
      piExecutable: process.execPath,
      effectivePath: '/usr/bin:/bin',
      agentDir: { mode: 'default' as const },
    },
    cwd: '/tmp',
    tmux: {
      socketSelector: 'name:default',
      sessionName: 'pi-test',
      windowIndex: 0,
      paneIndex: 0,
    },
    createdAt: '2026-07-31T00:00:00.000Z',
  };
}

describe('restart private store', () => {
  it('writes an atomic user-only recipe and derives an opaque generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-deck-restart-store-'));
    await writeRestartRecipe(recipe(), directory);

    const path = getRestartRecipePath(RUNTIME_ID, directory);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readRestartRecipe(RUNTIME_ID, directory)).toEqual(recipe());
    expect(await readFile(path, 'utf8')).not.toContain('SECRET');
    expect(createRestartGeneration(RUNTIME_ID, 42, '2026-07-31T00:00:00.000Z')).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
  });

  it('keeps an unresolved stopped operation visible after presence disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-deck-restart-recovery-'));
    const directory = join(root, 'restart');
    const identityDirectory = join(root, 'identity');
    await mkdir(identityDirectory, { recursive: true });
    await writeRestartRecipe(
      {
        ...recipe(),
        binding: {
          sessionId: 'session-1',
          sessionFile: '/tmp/session-1.jsonl',
          pid: 42,
          osProcessStartedAt: '2026-07-31T00:00:00.000Z',
          boundAt: '2026-07-31T00:00:00.000Z',
        },
      },
      directory,
    );
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        generation: 'opaque-generation-token',
        operationId: 'operation-1',
        state: 'stopped-not-restarted',
        coordinator: { pid: 99, osProcessStartedAt: '2026-07-31T00:00:00.000Z' },
        oldPid: 42,
        oldOsProcessStartedAt: '2026-07-31T00:00:00.000Z',
        oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: '2026-07-31T00:00:02.000Z',
        messageCode: 'respawn-failed',
      },
      directory,
    );
    await writeFile(
      getIdentityRecordPath(RUNTIME_ID, identityDirectory),
      JSON.stringify({ runtimeId: RUNTIME_ID, sessionId: 'session-1', sessionName: 'alpha' }),
    );

    const records = await readRestartRecoveryRecords(new Set(), {
      restartDirectory: directory,
      identityDirectory,
      now: new Date('2026-07-31T00:00:03.000Z'),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runtimeId: RUNTIME_ID,
      pid: null,
      presenceState: 'unknown',
      sessionName: 'alpha',
      restart: {
        available: true,
        generation: 'opaque-generation-token',
        operation: {
          operationId: 'operation-1',
          status: 'stopped-not-restarted',
          retryable: true,
        },
      },
    });
  });

  it.each(['term-sent', 'kill-sent'] as const)(
    'keeps a %s operation visible after normal presence reaping',
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), 'session-deck-restart-recovery-signal-'));
      const directory = join(root, 'restart');
      await writeRestartRecipe(
        {
          ...recipe(),
          binding: {
            sessionId: 'session-1',
            sessionFile: '/tmp/session-1.jsonl',
            pid: 42,
            osProcessStartedAt: '2026-07-31T00:00:00.000Z',
            boundAt: '2026-07-31T00:00:00.000Z',
          },
        },
        directory,
      );
      await writeRestartJournal(
        {
          schemaVersion: 1,
          runtimeId: RUNTIME_ID,
          generation: 'opaque-generation-token',
          operationId: `operation-${state}`,
          state,
          coordinator: { pid: 99, osProcessStartedAt: '2026-07-31T00:00:00.000Z' },
          oldPid: 42,
          oldOsProcessStartedAt: '2026-07-31T00:00:00.000Z',
          oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
          previousRemainOnExit: { explicit: false },
          pane: {
            id: '%1',
            socketPath: '/tmp/tmux-501/default',
            sessionName: 'pi-test',
            windowIndex: 0,
            paneIndex: 0,
          },
          updatedAt: '2026-07-31T00:00:02.000Z',
        },
        directory,
      );

      await expect(
        readRestartRecoveryRecords(new Set(), {
          restartDirectory: directory,
          now: new Date('2026-07-31T00:00:03.000Z'),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          runtimeId: RUNTIME_ID,
          restart: {
            available: true,
            generation: 'opaque-generation-token',
            operation: {
              operationId: `operation-${state}`,
              status: state,
              retryable: true,
            },
          },
        }),
      ]);
    },
  );

  it('distinguishes an absent journal from invalid and unreadable journal state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-deck-journal-read-'));
    await expect(readRestartJournal(RUNTIME_ID, directory)).resolves.toBeNull();

    const path = getRestartJournalPath(RUNTIME_ID, directory);
    await mkdir(join(directory, 'journals'), { recursive: true, mode: 0o700 });
    await writeFile(path, '{not-json', { mode: 0o600 });
    await expect(readRestartJournal(RUNTIME_ID, directory)).rejects.toThrow(
      'invalid-restart-journal',
    );

    await writeFile(path, '{}', { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(readRestartJournal(RUNTIME_ID, directory)).rejects.toThrow(
      'invalid-restart-journal',
    );
  });

  it('rejects journal states without their recovery fields and recipe writes the reader cannot accept', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-deck-write-contract-'));
    await expect(
      writeRestartJournal(
        {
          schemaVersion: 1,
          runtimeId: RUNTIME_ID,
          generation: 'opaque-generation-token',
          operationId: 'operation-invalid',
          state: 'spawn-requested',
          coordinator: { pid: 99, osProcessStartedAt: '2026-07-31T00:00:00.000Z' },
          oldPid: 42,
          oldOsProcessStartedAt: '2026-07-31T00:00:00.000Z',
          oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
          updatedAt: '2026-07-31T00:00:02.000Z',
        } as unknown as RestartJournalV1,
        directory,
      ),
    ).rejects.toThrow('invalid-restart-journal');

    const invalidRecipe = {
      ...recipe(),
      launch: {
        ...recipe().launch,
        agentDir: { mode: 'custom' as const },
      },
    };
    await expect(
      writeRestartRecipe(invalidRecipe as unknown as ManagedRestartRecipeV1, directory),
    ).rejects.toThrow('invalid-restart-recipe');
    await expect(readRestartRecipe(RUNTIME_ID, directory)).resolves.toBeNull();
  });

  it('accepts only the three browser-safe restart request fields', () => {
    const valid = {
      runtimeId: RUNTIME_ID,
      generation: 'opaque-generation-token',
      operationId: 'operation-1',
    };
    expect(normalizeRestartSessionRequest(valid)).toEqual(valid);
    expect(
      normalizeRestartSessionRequest({ ...valid, sessionFile: '/private/session.jsonl' }),
    ).toBeNull();
    expect(normalizeRestartSessionRequest({ ...valid, runtimeId: '../unsafe' })).toBeNull();
  });
});
