import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRestartEligibility } from '../../extensions/session-deck/restart/eligibility.js';
import {
  createRestartGeneration,
  writeRestartJournal,
  writeRestartRecipe,
} from '../../extensions/session-deck/restart/store.js';

const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';
const MARKER = '2026-07-31T00:00:00.000Z';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-restart-eligibility-'));
  await writeRestartRecipe(
    {
      schemaVersion: 1,
      runtimeId: RUNTIME_ID,
      launch: {
        piExecutable: process.execPath,
        effectivePath: '/usr/bin:/bin',
        agentDir: { mode: 'default' },
      },
      cwd: '/tmp/project',
      tmux: {
        socketSelector: 'name:default',
        sessionName: 'pi-project',
        windowIndex: 0,
        paneIndex: 0,
      },
      createdAt: MARKER,
      binding: {
        sessionId: 'session-1',
        sessionFile: '/tmp/session-1.jsonl',
        pid: 42,
        osProcessStartedAt: MARKER,
        boundAt: MARKER,
      },
    },
    directory,
  );
  return directory;
}

const observed = {
  pid: 42,
  sessionId: 'session-1',
  sessionFile: '/tmp/session-1.jsonl',
  cwd: '/tmp/project',
  processPid: 42,
  terminal: {
    kind: 'tmux' as const,
    socketPath: '/tmp/tmux-501/default',
    sessionName: 'pi-project',
    windowIndex: 0,
    paneIndex: 0,
    panePid: 42,
  },
};

describe('restart eligibility', () => {
  it('requires the currently observed identity, pane, and OS generation to match the binding', async () => {
    const directory = await fixture();
    await expect(
      readRestartEligibility(RUNTIME_ID, {
        directory,
        observed,
        readPidStartedAt: async () => MARKER,
      }),
    ).resolves.toMatchObject({ available: true });
    await expect(
      readRestartEligibility(RUNTIME_ID, {
        directory,
        observed: { ...observed, pid: 43 },
        readPidStartedAt: async () => MARKER,
      }),
    ).resolves.toEqual({ available: false, reason: 'identity-mismatch' });
    await expect(
      readRestartEligibility(RUNTIME_ID, {
        directory,
        observed,
        readPidStartedAt: async () => '2026-07-31T00:01:00.000Z',
      }),
    ).resolves.toEqual({ available: false, reason: 'generation-changed' });
  });

  it('surfaces hosting-runtime and descendant ineligibility before confirmation', async () => {
    const directory = await fixture();
    await expect(
      readRestartEligibility(RUNTIME_ID, {
        directory,
        observed,
        hostingRuntimeId: RUNTIME_ID,
        readPidStartedAt: async () => MARKER,
        readDescendantPids: async () => [],
      }),
    ).resolves.toEqual({ available: false, reason: 'hosting-runtime' });
    await expect(
      readRestartEligibility(RUNTIME_ID, {
        directory,
        observed,
        readPidStartedAt: async () => MARKER,
        readDescendantPids: async () => [43],
      }),
    ).resolves.toEqual({ available: false, reason: 'unsafe-descendants' });
  });

  it('keeps the old generation and operation id for unresolved same-operation reconciliation', async () => {
    const directory = await fixture();
    const generation = createRestartGeneration(RUNTIME_ID, 42, MARKER);
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        generation,
        operationId: 'operation-unknown',
        state: 'outcome-unknown',
        coordinator: { pid: 99, osProcessStartedAt: MARKER },
        oldPid: 42,
        oldOsProcessStartedAt: MARKER,
        oldPresenceStartedAt: MARKER,
        updatedAt: MARKER,
      },
      directory,
    );

    await expect(readRestartEligibility(RUNTIME_ID, { directory })).resolves.toEqual({
      available: true,
      generation,
      operation: {
        operationId: 'operation-unknown',
        status: 'outcome-unknown',
        retryable: true,
      },
    });
  });
});
