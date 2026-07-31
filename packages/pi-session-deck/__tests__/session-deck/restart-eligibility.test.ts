import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionTmuxTerminalMetadata } from '../../extensions/session-deck/identity/types.js';
import type { RestartEligibilityObservation } from '../../extensions/session-deck/restart/eligibility.js';
import { readRestartEligibility } from '../../extensions/session-deck/restart/eligibility.js';
import {
  createRestartGeneration,
  writeRestartJournal,
  writeRestartRecipe,
} from '../../extensions/session-deck/restart/store.js';

const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';
const MARKER = '2026-07-31T00:00:00.000Z';

async function fixture(socketSelector = 'name:default') {
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
        socketSelector,
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

const observed: RestartEligibilityObservation = {
  pid: 42,
  sessionId: 'session-1',
  sessionFile: '/tmp/session-1.jsonl',
  cwd: '/tmp/project',
  processPid: 42,
  terminal: {
    kind: 'tmux',
    socketPath: '/tmp/tmux-501/default',
    sessionName: 'pi-project',
    windowIndex: 0,
    paneIndex: 0,
    panePid: 42,
  },
};

function withTmuxTerminal(
  value: RestartEligibilityObservation,
  overrides: Partial<SessionTmuxTerminalMetadata>,
): RestartEligibilityObservation {
  if (value.terminal?.kind !== 'tmux') throw new Error('Expected a tmux observation.');
  return { ...value, terminal: { ...value.terminal, ...overrides } };
}

const selectorCases = [
  { label: 'name', selector: 'name:default', socketPath: '/tmp/tmux-501/default' },
  {
    label: 'path',
    selector: 'path:/tmp/tmux-501/private',
    socketPath: '/tmp/tmux-501/private',
  },
] as const;

const mismatchCases = [
  { label: 'pid', mutate: (value: RestartEligibilityObservation) => ({ ...value, pid: 43 }) },
  {
    label: 'session id',
    mutate: (value: RestartEligibilityObservation) => ({ ...value, sessionId: 'session-2' }),
  },
  {
    label: 'session file',
    mutate: (value: RestartEligibilityObservation) => ({
      ...value,
      sessionFile: '/tmp/session-2.jsonl',
    }),
  },
  {
    label: 'cwd',
    mutate: (value: RestartEligibilityObservation) => ({ ...value, cwd: '/tmp/other' }),
  },
  {
    label: 'process pid',
    mutate: (value: RestartEligibilityObservation) => ({ ...value, processPid: 43 }),
  },
  {
    label: 'terminal kind',
    mutate: (value: RestartEligibilityObservation) => ({
      ...value,
      terminal: {
        kind: 'iterm2' as const,
        sessionId: 'iterm-session',
        revealUrl: 'iterm2:///reveal',
      },
    }),
  },
  {
    label: 'tmux session name',
    mutate: (value: RestartEligibilityObservation) =>
      withTmuxTerminal(value, { sessionName: 'other-session' }),
  },
  {
    label: 'tmux window index',
    mutate: (value: RestartEligibilityObservation) => withTmuxTerminal(value, { windowIndex: 1 }),
  },
  {
    label: 'tmux pane index',
    mutate: (value: RestartEligibilityObservation) => withTmuxTerminal(value, { paneIndex: 1 }),
  },
  {
    label: 'tmux pane pid',
    mutate: (value: RestartEligibilityObservation) => withTmuxTerminal(value, { panePid: 43 }),
  },
  {
    label: 'tmux socket path',
    mutate: (value: RestartEligibilityObservation) =>
      withTmuxTerminal(value, { socketPath: '/tmp/tmux-501/other' }),
  },
] as const;

describe('restart eligibility', () => {
  it.each(selectorCases)(
    'accepts matching $label tmux socket selectors',
    async ({ selector, socketPath }) => {
      const directory = await fixture(selector);
      const current = withTmuxTerminal(observed, { socketPath });
      await expect(
        readRestartEligibility(RUNTIME_ID, {
          directory,
          observed: current,
          readPidStartedAt: async () => MARKER,
          readDescendantPids: async () => [],
        }),
      ).resolves.toMatchObject({ available: true });
    },
  );

  it.each(
    selectorCases.flatMap((selectorCase) =>
      mismatchCases.map((mismatchCase) => ({ ...selectorCase, ...mismatchCase })),
    ),
  )(
    'rejects a $label mismatch for the $selector selector',
    async ({ selector, socketPath, mutate }) => {
      const directory = await fixture(selector);
      const current = withTmuxTerminal(observed, { socketPath });
      await expect(
        readRestartEligibility(RUNTIME_ID, {
          directory,
          observed: mutate(current),
          readPidStartedAt: async () => MARKER,
        }),
      ).resolves.toEqual({ available: false, reason: 'identity-mismatch' });
    },
  );

  it('rejects a changed OS process generation', async () => {
    const directory = await fixture();
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
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: MARKER,
        messageCode: 'replacement-unobserved',
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
