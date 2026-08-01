import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getIdentityRecordPath } from '../../extensions/session-deck/identity/store.js';
import { getPresenceRecordPath } from '../../extensions/session-deck/presence/store.js';
import {
  buildRestartCommand,
  restartSessionDeckRuntime,
} from '../../extensions/session-deck/restart/orchestrator.js';
import {
  createRestartGeneration,
  getRestartJournalPath,
  getRestartLockPath,
  readRestartJournal,
  writeRestartJournal,
  writeRestartRecipe,
} from '../../extensions/session-deck/restart/store.js';
import type {
  ManagedRestartRecipeV1,
  RestartJournalV1,
} from '../../extensions/session-deck/restart/types.js';

const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';
const OLD_MARKER = '2026-07-31T00:00:00.000Z';
const NEW_MARKER = '2026-07-31T00:01:00.000Z';
const SESSION_ID = 'session-1';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-deck-restart-'));
  const restartDirectory = join(root, 'restart');
  const presenceDirectory = join(root, 'presence');
  const identityDirectory = join(root, 'identity');
  const cwd = join(root, 'cwd');
  const sessionFile = join(root, 'session.jsonl');
  await Promise.all([
    mkdir(presenceDirectory, { recursive: true }),
    mkdir(identityDirectory, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: SESSION_ID, cwd })}\n`);
  const recipe: ManagedRestartRecipeV1 = {
    schemaVersion: 1,
    runtimeId: RUNTIME_ID,
    launch: {
      piExecutable: process.execPath,
      effectivePath: '/usr/bin:/bin',
      agentDir: { mode: 'default' },
    },
    cwd,
    tmux: {
      socketSelector: 'name:default',
      sessionName: 'pi-managed-test',
      windowIndex: 0,
      paneIndex: 0,
    },
    createdAt: OLD_MARKER,
    binding: {
      sessionId: SESSION_ID,
      sessionFile,
      pid: 4100,
      osProcessStartedAt: OLD_MARKER,
      boundAt: OLD_MARKER,
    },
  };
  await writeRestartRecipe(recipe, restartDirectory);
  await writeFile(
    getPresenceRecordPath(RUNTIME_ID, presenceDirectory),
    JSON.stringify({
      runtimeId: RUNTIME_ID,
      pid: 4100,
      startedAt: '2026-07-31T00:00:01.000Z',
      heartbeatAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    getIdentityRecordPath(RUNTIME_ID, identityDirectory),
    JSON.stringify({
      runtimeId: RUNTIME_ID,
      sessionId: SESSION_ID,
      sessionFile,
      cwd,
      identityUpdatedAt: '2026-07-31T00:00:01.000Z',
    }),
  );
  return { root, restartDirectory, presenceDirectory, identityDirectory, recipe };
}

function paneOutput(dead: boolean, pid: number, cwd: string, paneId = '%1') {
  return `${dead ? 1 : 0}\u001f${pid}\u001fpi-managed-test\u001f0\u001f0\u001f${paneId}\u001f/tmp/tmux-501/default\u001f${dead ? '' : cwd}\n`;
}

describe('restart lifecycle', () => {
  it('preflights, retains, TERM-stops, respawns the exact pane without -k, and observes a new generation', async () => {
    const files = await fixture();
    let oldAlive = true;
    let paneDead = false;
    let panePid = 4100;
    const calls: string[][] = [];
    const signal = vi.fn(() => {
      oldAlive = false;
      paneDead = true;
    });
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message')) {
        return { stdout: paneOutput(paneDead, panePid, files.recipe.cwd), stderr: '', exitCode: 0 };
      }
      if (args.includes('show-options')) {
        return args.includes('-A')
          ? { stdout: 'off\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('respawn-pane')) {
        expect(args).not.toContain('-k');
        paneDead = false;
        panePid = 4200;
        await writeRestartRecipe(
          {
            ...files.recipe,
            binding: {
              ...files.recipe.binding!,
              pid: 4200,
              osProcessStartedAt: NEW_MARKER,
              boundAt: NEW_MARKER,
            },
          },
          files.restartDirectory,
        );
        await writeFile(
          getPresenceRecordPath(RUNTIME_ID, files.presenceDirectory),
          JSON.stringify({
            runtimeId: RUNTIME_ID,
            pid: 4200,
            startedAt: '2026-07-31T00:01:01.000Z',
            heartbeatAt: new Date().toISOString(),
          }),
        );
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-1',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        exec,
        signal,
        readPidStartedAt: async (pid) =>
          pid === 999
            ? '2026-07-31T00:00:30.000Z'
            : pid === 4100 && oldAlive
              ? OLD_MARKER
              : pid === 4200
                ? NEW_MARKER
                : null,
        sleep: async () => undefined,
        termGraceMs: 1,
        paneDeadWaitMs: 1,
        observeMs: 5,
      },
    );

    expect(response).toMatchObject({ ok: true, status: 'restarted', operationId: 'operation-1' });
    expect(signal).toHaveBeenCalledWith(4100, 'SIGTERM');
    const respawn = calls.find((call) => call.includes('respawn-pane'))!;
    expect(respawn.join(' ')).toContain('%1');
    expect(respawn.at(-1)).toContain(`--session ${files.recipe.binding!.sessionFile}`);
    expect(calls.some((call) => call.includes('-u') && call.includes('remain-on-exit'))).toBe(true);
  });

  it('uses bounded KILL only after TERM leaves the exact child-free generation alive', async () => {
    const files = await fixture();
    let oldAlive = true;
    let paneDead = false;
    const signal = vi.fn((_pid: number, signalName: NodeJS.Signals) => {
      if (signalName === 'SIGKILL') {
        oldAlive = false;
        paneDead = true;
      }
    });
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message'))
        return { stdout: paneOutput(paneDead, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('show-options'))
        return args.includes('-A')
          ? { stdout: 'off\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('respawn-pane'))
        return { stdout: '', stderr: 'forced failure', exitCode: 1 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-force-kill',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        exec,
        signal,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : pid === 4100 && oldAlive ? OLD_MARKER : null,
        sleep: async () => undefined,
        termGraceMs: 1,
        killGraceMs: 1,
        paneDeadWaitMs: 1,
      },
    );

    expect(response).toMatchObject({ status: 'stopped-not-restarted', reason: 'respawn-failed' });
    expect(signal.mock.calls).toEqual([
      [4100, 'SIGTERM'],
      [4100, 'SIGKILL'],
    ]);
  });

  it.each([
    {
      label: 'a live descendant',
      ps: { stdout: '4100 1\n4200 4100\n', exitCode: 0 },
    },
    {
      label: 'a failed process-table inspection',
      ps: { stdout: '4100 1\n', exitCode: 1 },
    },
  ])('refuses $label before pane retention or signaling', async ({ ps }) => {
    const files = await fixture();
    const signal = vi.fn();
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { ...ps, stderr: '' };
      if (args.includes('display-message'))
        return { stdout: paneOutput(false, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-descendant',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        signal,
        exec,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : pid === 4100 ? OLD_MARKER : null,
      },
    );

    expect(response).toMatchObject({ status: 'not-eligible', reason: 'unsafe-descendants' });
    expect(signal).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([, args]) => args.includes('set-option'))).toBe(false);
  });

  it('rejects a stale generation before signaling or changing tmux options', async () => {
    const files = await fixture();
    const signal = vi.fn();
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
    const response = await restartSessionDeckRuntime(
      { runtimeId: RUNTIME_ID, generation: 'stale-generation-token', operationId: 'operation-2' },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        signal,
        exec,
        readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : OLD_MARKER),
      },
    );
    expect(response.status).toBe('stale-generation');
    expect(signal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not repeat TERM when recovering a stale coordinator after TERM was journaled', async () => {
    const files = await fixture();
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-recover-term',
        state: 'term-sent',
        coordinator: { pid: 888, osProcessStartedAt: OLD_MARKER },
        oldPid: 4100,
        oldOsProcessStartedAt: OLD_MARKER,
        oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-managed-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: OLD_MARKER,
      },
      files.restartDirectory,
    );
    const signal = vi.fn();
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-recover-term',
      },
      {
        restartDirectory: files.restartDirectory,
        currentPid: 999,
        signal,
        exec,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : pid === 4100 ? OLD_MARKER : null,
      },
    );

    expect(response).toMatchObject({ status: 'stop-failed', reason: 'termination-failed' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('refuses a pane-id replacement after retention without signaling either process', async () => {
    const files = await fixture();
    let paneRead = 0;
    const signal = vi.fn();
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message')) {
        paneRead += 1;
        return {
          stdout: paneOutput(false, 4100, files.recipe.cwd, paneRead === 1 ? '%1' : '%2'),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args.includes('show-options'))
        return args.includes('-A')
          ? { stdout: 'on\n', stderr: '', exitCode: 0 }
          : { stdout: 'on\n', stderr: '', exitCode: 0 };
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-pane-race',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        signal,
        exec,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : pid === 4100 ? OLD_MARKER : null,
      },
    );

    expect(response).toMatchObject({ status: 'stale-generation', reason: 'generation-changed' });
    expect(signal).not.toHaveBeenCalled();
    const optionWrites = exec.mock.calls
      .map(([, args]) => args)
      .filter((args) => args.includes('set-option'));
    expect(optionWrites.at(-1)).toContain('on');
  });

  it('restores remain-on-exit before deleting a preparing journal after a pre-TERM failure', async () => {
    const files = await fixture();
    let paneRead = 0;
    let journalExistedDuringRestore = false;
    const signal = vi.fn();
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message')) {
        paneRead += 1;
        if (paneRead > 1) throw new Error('inspection failed');
        return { stdout: paneOutput(false, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      }
      if (args.includes('show-options')) return { stdout: 'off\n', stderr: '', exitCode: 0 };
      if (args.includes('set-option')) {
        if (args.at(-1) === 'off') {
          journalExistedDuringRestore = await readFile(
            getRestartJournalPath(RUNTIME_ID, files.restartDirectory),
            'utf8',
          ).then(
            () => true,
            () => false,
          );
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    await expect(
      restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: 'operation-pre-term-cleanup',
        },
        {
          restartDirectory: files.restartDirectory,
          presenceDirectory: files.presenceDirectory,
          identityDirectory: files.identityDirectory,
          currentPid: 999,
          exec,
          signal,
          readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : OLD_MARKER),
        },
      ),
    ).rejects.toThrow('Restart operation failed before process mutation.');
    expect(signal).not.toHaveBeenCalled();
    expect(journalExistedDuringRestore).toBe(true);
    await expect(
      readFile(getRestartJournalPath(RUNTIME_ID, files.restartDirectory), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a preparing journal when pre-TERM option restoration fails', async () => {
    const files = await fixture();
    let paneRead = 0;
    const signal = vi.fn();
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message')) {
        paneRead += 1;
        if (paneRead > 1) throw new Error('inspection failed');
        return { stdout: paneOutput(false, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      }
      if (args.includes('show-options')) return { stdout: 'off\n', stderr: '', exitCode: 0 };
      if (args.includes('set-option'))
        return args.at(-1) === 'off'
          ? { stdout: '', stderr: 'restore failed', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    await expect(
      restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: 'operation-restore-failed',
        },
        {
          restartDirectory: files.restartDirectory,
          presenceDirectory: files.presenceDirectory,
          identityDirectory: files.identityDirectory,
          currentPid: 999,
          exec,
          signal,
          readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : OLD_MARKER),
        },
      ),
    ).rejects.toThrow('remain-on-exit-restore-failed');
    expect(signal).not.toHaveBeenCalled();
    await expect(readRestartJournal(RUNTIME_ID, files.restartDirectory)).resolves.toMatchObject({
      state: 'preparing',
      previousRemainOnExit: { explicit: true, value: 'off' },
    });
  });

  it('does not declare exit, send KILL, or respawn when the post-TERM PID probe is unverified', async () => {
    const files = await fixture();
    let inspectionFails = false;
    const signal = vi.fn(() => {
      inspectionFails = true;
    });
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message'))
        return { stdout: paneOutput(false, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('show-options'))
        return args.includes('-A')
          ? { stdout: 'off\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-probe-failure',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        exec,
        signal,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : inspectionFails ? null : OLD_MARKER,
        probePidExists: () => ({ exists: true }),
        sleep: async () => undefined,
        termGraceMs: 1,
      },
    );

    expect(response).toMatchObject({ status: 'stop-failed', reason: 'termination-failed' });
    expect(signal.mock.calls).toEqual([[4100, 'SIGTERM']]);
    expect(exec.mock.calls.some(([, args]) => args.includes('respawn-pane'))).toBe(false);
  });

  it('treats a reused PID as the old generation gone but still requires a dead pane before respawn', async () => {
    const files = await fixture();
    let observedMarker = OLD_MARKER;
    let paneDead = false;
    const signal = vi.fn(() => {
      observedMarker = NEW_MARKER;
      paneDead = true;
    });
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message'))
        return { stdout: paneOutput(paneDead, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('show-options'))
        return args.includes('-A')
          ? { stdout: 'off\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('respawn-pane'))
        return { stdout: '', stderr: 'forced failure', exitCode: 1 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-pid-reuse',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        exec,
        signal,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : observedMarker,
        sleep: async () => undefined,
        termGraceMs: 1,
        paneDeadWaitMs: 1,
      },
    );

    expect(response).toMatchObject({ status: 'stopped-not-restarted', reason: 'respawn-failed' });
    expect(signal.mock.calls).toEqual([[4100, 'SIGTERM']]);
    expect(exec.mock.calls.some(([, args]) => args.includes('respawn-pane'))).toBe(true);
  });

  it('does not reclaim a live lock owner when its process start probe is unavailable', async () => {
    const files = await fixture();
    const lockPath = getRestartLockPath(RUNTIME_ID, files.restartDirectory);
    await mkdir(join(files.restartDirectory, 'locks'), { recursive: true, mode: 0o700 });
    await writeFile(
      lockPath,
      JSON.stringify({
        operationId: 'other-operation',
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        pid: 888,
        osProcessStartedAt: OLD_MARKER,
      }),
      { mode: 0o600 },
    );
    const signal = vi.fn();

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-lock-probe-failure',
      },
      {
        restartDirectory: files.restartDirectory,
        currentPid: 999,
        signal,
        readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : null),
        probePidExists: () => ({ exists: true }),
      },
    );

    expect(response).toMatchObject({ status: 'already-in-progress' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('keeps an ownerless legacy lock when target state reconciliation is unverified', async () => {
    const files = await fixture();
    await mkdir(getRestartLockPath(RUNTIME_ID, files.restartDirectory), {
      recursive: true,
      mode: 0o700,
    });
    const signal = vi.fn();
    const exec = vi.fn();

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-ownerless-unverified',
      },
      {
        restartDirectory: files.restartDirectory,
        currentPid: 999,
        signal,
        exec,
        readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : null),
        probePidExists: () => ({ exists: true }),
      },
    );

    expect(response).toMatchObject({ status: 'already-in-progress' });
    expect(signal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('recovers a private ownerless legacy lock after journal and target generation reconciliation', async () => {
    const files = await fixture();
    const lockPath = getRestartLockPath(RUNTIME_ID, files.restartDirectory);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    const signal = vi.fn();
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'missing pane', exitCode: 1 }));

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-ownerless-lock',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        signal,
        exec,
        readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : OLD_MARKER),
      },
    );

    expect(response).toMatchObject({ status: 'not-eligible', reason: 'tmux-target-unavailable' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('cancels and settles a timed-out respawn before returning outcome-unknown', async () => {
    const files = await fixture();
    let oldAlive = true;
    let paneDead = false;
    let respawnAborted = false;
    let respawnSettled = false;
    let resolveRespawnStarted: () => void = () => undefined;
    const respawnStarted = new Promise<void>((resolve) => {
      resolveRespawnStarted = resolve;
    });
    const internalOperationMs = 25;
    const exec = vi.fn(
      async (file: string, args: readonly string[], options: { signal: AbortSignal }) => {
        if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
        if (args.includes('display-message'))
          return { stdout: paneOutput(paneDead, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
        if (args.includes('show-options'))
          return args.includes('-A')
            ? { stdout: 'off\n', stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '', exitCode: 0 };
        if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
        if (args.includes('respawn-pane')) {
          resolveRespawnStarted();
          return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
            (resolve) => {
              options.signal.addEventListener('abort', () => {
                respawnAborted = true;
                queueMicrotask(() => {
                  respawnSettled = true;
                  resolve({ stdout: '', stderr: 'aborted', exitCode: 1 });
                });
              });
            },
          );
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    );

    vi.useFakeTimers();
    try {
      const operation = restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: 'operation-deadline',
        },
        {
          restartDirectory: files.restartDirectory,
          presenceDirectory: files.presenceDirectory,
          identityDirectory: files.identityDirectory,
          currentPid: 999,
          exec,
          signal: () => {
            oldAlive = false;
            paneDead = true;
          },
          readPidStartedAt: async (pid) =>
            pid === 999 ? '2026-07-31T00:00:30.000Z' : pid === 4100 && oldAlive ? OLD_MARKER : null,
          sleep: async () => undefined,
          termGraceMs: 1,
          paneDeadWaitMs: 1,
          internalOperationMs,
        },
      );
      await respawnStarted;
      await vi.advanceTimersByTimeAsync(internalOperationMs);
      await expect(operation).resolves.toMatchObject({
        status: 'outcome-unknown',
        reason: 'operation-state-unknown',
        retryable: true,
      });
      expect(respawnAborted).toBe(true);
      expect(respawnSettled).toBe(true);
      await expect(
        readFile(getRestartLockPath(RUNTIME_ID, files.restartDirectory), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['spawn-requested', 'observing', 'outcome-unknown'] as const)(
    'continues the same %s operation from a dead retained pane without another signal',
    async (state) => {
      const files = await fixture();
      await writeRestartJournal(
        {
          schemaVersion: 1,
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: `operation-reconcile-${state}`,
          state,
          coordinator: { pid: 888, osProcessStartedAt: OLD_MARKER },
          oldPid: 4100,
          oldOsProcessStartedAt: OLD_MARKER,
          oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
          previousRemainOnExit: { explicit: false },
          pane: {
            id: '%1',
            socketPath: '/tmp/tmux-501/default',
            sessionName: 'pi-managed-test',
            windowIndex: 0,
            paneIndex: 0,
          },
          updatedAt: NEW_MARKER,
          ...(state === 'outcome-unknown'
            ? { messageCode: 'replacement-unobserved' as const }
            : {}),
        } as RestartJournalV1,
        files.restartDirectory,
      );
      const signal = vi.fn();
      const exec = vi.fn(async (_file: string, args: readonly string[]) => {
        if (args.includes('display-message'))
          return { stdout: paneOutput(true, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
        if (args.includes('respawn-pane'))
          return { stdout: '', stderr: 'forced failure', exitCode: 1 };
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      });

      const response = await restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: `operation-reconcile-${state}`,
        },
        {
          restartDirectory: files.restartDirectory,
          currentPid: 999,
          exec,
          signal,
          readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : null),
          probePidExists: () => ({ exists: false }),
          sleep: async () => undefined,
          observeMs: 1,
        },
      );

      expect(response).toMatchObject({
        status: 'stopped-not-restarted',
        reason: 'respawn-failed',
      });
      expect(signal).not.toHaveBeenCalled();
      expect(exec.mock.calls.filter(([, args]) => args.includes('respawn-pane'))).toHaveLength(1);
    },
  );

  it('continues after an immediately exited replacement leaves the retained pane dead', async () => {
    const files = await fixture();
    await writeRestartRecipe(
      {
        ...files.recipe,
        binding: {
          ...files.recipe.binding!,
          pid: 4200,
          osProcessStartedAt: NEW_MARKER,
          boundAt: NEW_MARKER,
        },
      },
      files.restartDirectory,
    );
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-exited-replacement',
        state: 'observing',
        coordinator: { pid: 888, osProcessStartedAt: OLD_MARKER },
        oldPid: 4100,
        oldOsProcessStartedAt: OLD_MARKER,
        oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-managed-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: NEW_MARKER,
      },
      files.restartDirectory,
    );
    const signal = vi.fn();
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('display-message'))
        return { stdout: paneOutput(true, 4200, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('respawn-pane'))
        return { stdout: '', stderr: 'forced failure', exitCode: 1 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    await expect(
      restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: 'operation-exited-replacement',
        },
        {
          restartDirectory: files.restartDirectory,
          currentPid: 999,
          exec,
          signal,
          readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : null),
          probePidExists: () => ({ exists: false }),
          sleep: async () => undefined,
          observeMs: 1,
        },
      ),
    ).resolves.toMatchObject({ status: 'stopped-not-restarted', reason: 'respawn-failed' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('uses persisted spawn-requested state when a stopped retry throws after the spawn transition', async () => {
    const files = await fixture();
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-retry-throws',
        state: 'stopped-not-restarted',
        coordinator: { pid: 888, osProcessStartedAt: OLD_MARKER },
        oldPid: 4100,
        oldOsProcessStartedAt: OLD_MARKER,
        oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-managed-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: NEW_MARKER,
        messageCode: 'respawn-failed',
      },
      files.restartDirectory,
    );
    const signal = vi.fn();
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('display-message'))
        return { stdout: paneOutput(true, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('respawn-pane')) throw new Error('executor failed');
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    await expect(
      restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: 'operation-retry-throws',
        },
        {
          restartDirectory: files.restartDirectory,
          currentPid: 999,
          exec,
          signal,
          readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : null),
          probePidExists: () => ({ exists: false }),
        },
      ),
    ).resolves.toMatchObject({
      status: 'outcome-unknown',
      reason: 'operation-state-unknown',
    });
    expect(signal).not.toHaveBeenCalled();
    await expect(readRestartJournal(RUNTIME_ID, files.restartDirectory)).resolves.toMatchObject({
      state: 'outcome-unknown',
      messageCode: 'operation-state-unknown',
    });
  });

  it('fails closed on an invalid journal before tmux inspection or signaling', async () => {
    const files = await fixture();
    const journalPath = getRestartJournalPath(RUNTIME_ID, files.restartDirectory);
    await mkdir(join(files.restartDirectory, 'journals'), { recursive: true, mode: 0o700 });
    await writeFile(journalPath, '{not-json', { mode: 0o600 });
    const signal = vi.fn();
    const exec = vi.fn();

    await expect(
      restartSessionDeckRuntime(
        {
          runtimeId: RUNTIME_ID,
          generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
          operationId: 'operation-invalid-journal',
        },
        {
          restartDirectory: files.restartDirectory,
          currentPid: 999,
          exec,
          signal,
          readPidStartedAt: async (pid) => (pid === 999 ? '2026-07-31T00:00:30.000Z' : OLD_MARKER),
        },
      ),
    ).rejects.toThrow('invalid-restart-journal');
    expect(signal).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('reconciles a same-PID replacement after an unknown outcome when its start marker changes', async () => {
    const files = await fixture();
    await writeRestartRecipe(
      {
        ...files.recipe,
        binding: {
          ...files.recipe.binding!,
          osProcessStartedAt: NEW_MARKER,
          boundAt: NEW_MARKER,
        },
      },
      files.restartDirectory,
    );
    await writeFile(
      getPresenceRecordPath(RUNTIME_ID, files.presenceDirectory),
      JSON.stringify({
        runtimeId: RUNTIME_ID,
        pid: 4100,
        startedAt: NEW_MARKER,
        heartbeatAt: new Date().toISOString(),
      }),
    );
    await writeRestartJournal(
      {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-recover-same-pid',
        state: 'outcome-unknown',
        coordinator: { pid: 888, osProcessStartedAt: OLD_MARKER },
        oldPid: 4100,
        oldOsProcessStartedAt: OLD_MARKER,
        oldPresenceStartedAt: '2026-07-31T00:00:01.000Z',
        previousRemainOnExit: { explicit: false },
        pane: {
          id: '%1',
          socketPath: '/tmp/tmux-501/default',
          sessionName: 'pi-managed-test',
          windowIndex: 0,
          paneIndex: 0,
        },
        updatedAt: NEW_MARKER,
        messageCode: 'replacement-unobserved',
      },
      files.restartDirectory,
    );

    const signal = vi.fn();
    const exec = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.includes('display-message'))
        return { stdout: paneOutput(false, 4100, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-recover-same-pid',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        exec,
        signal,
        readPidStartedAt: async (pid) =>
          pid === 999 ? '2026-07-31T00:00:30.000Z' : pid === 4100 ? NEW_MARKER : null,
        sleep: async () => undefined,
        observeMs: 5,
      },
    );

    expect(response).toMatchObject({ status: 'restarted', reason: 'replacement-observed' });
    expect(signal).not.toHaveBeenCalled();
  });

  it('observes a changed replacement PID even when the OS start marker has second resolution', async () => {
    const files = await fixture();
    let oldAlive = true;
    let paneDead = false;
    let panePid = 4100;
    const exec = vi.fn(async (file: string, args: readonly string[]) => {
      if (file === 'ps') return { stdout: '4100 1\n', stderr: '', exitCode: 0 };
      if (args.includes('display-message'))
        return { stdout: paneOutput(paneDead, panePid, files.recipe.cwd), stderr: '', exitCode: 0 };
      if (args.includes('show-options'))
        return args.includes('-A')
          ? { stdout: 'off\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('set-option')) return { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('respawn-pane')) {
        paneDead = false;
        panePid = 4200;
        await writeRestartRecipe(
          {
            ...files.recipe,
            binding: {
              ...files.recipe.binding!,
              pid: 4200,
              osProcessStartedAt: OLD_MARKER,
              boundAt: NEW_MARKER,
            },
          },
          files.restartDirectory,
        );
        await writeFile(
          getPresenceRecordPath(RUNTIME_ID, files.presenceDirectory),
          JSON.stringify({
            runtimeId: RUNTIME_ID,
            pid: 4200,
            startedAt: NEW_MARKER,
            heartbeatAt: new Date().toISOString(),
          }),
        );
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 };
    });

    const response = await restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'operation-same-second',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        exec,
        signal: () => {
          oldAlive = false;
          paneDead = true;
        },
        readPidStartedAt: async (pid) =>
          pid === 999
            ? '2026-07-31T00:00:30.000Z'
            : pid === 4100 && oldAlive
              ? OLD_MARKER
              : pid === 4200
                ? OLD_MARKER
                : null,
        sleep: async () => undefined,
        termGraceMs: 1,
        paneDeadWaitMs: 1,
        observeMs: 5,
      },
    );

    expect(response).toMatchObject({ status: 'restarted', reason: 'replacement-observed' });
  });

  it('does not delete a successor lock after reading a stale owner', async () => {
    const files = await fixture();
    const lockPath = getRestartLockPath(RUNTIME_ID, files.restartDirectory);
    await mkdir(join(files.restartDirectory, 'locks'), { recursive: true, mode: 0o700 });
    await writeFile(
      lockPath,
      JSON.stringify({
        operationId: 'stale-operation',
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        pid: 888,
        osProcessStartedAt: OLD_MARKER,
      }),
      { mode: 0o600 },
    );

    let staleRead!: () => void;
    const staleReadStarted = new Promise<void>((resolve) => {
      staleRead = resolve;
    });
    let allowStaleInspection!: () => void;
    const staleInspection = new Promise<void>((resolve) => {
      allowStaleInspection = resolve;
    });
    let successorReachedPreflight!: () => void;
    const successorInPreflight = new Promise<void>((resolve) => {
      successorReachedPreflight = resolve;
    });
    let allowSuccessorToFinish!: () => void;
    const successorFinish = new Promise<void>((resolve) => {
      allowSuccessorToFinish = resolve;
    });

    const first = restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'delayed-reclaimer',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 999,
        readPidStartedAt: async (pid) => {
          if (pid === 999) return '2026-07-31T00:00:30.000Z';
          if (pid === 888) {
            staleRead();
            await staleInspection;
            return NEW_MARKER;
          }
          return OLD_MARKER;
        },
      },
    );
    await staleReadStarted;

    const second = restartSessionDeckRuntime(
      {
        runtimeId: RUNTIME_ID,
        generation: createRestartGeneration(RUNTIME_ID, 4100, OLD_MARKER),
        operationId: 'successor-operation',
      },
      {
        restartDirectory: files.restartDirectory,
        presenceDirectory: files.presenceDirectory,
        identityDirectory: files.identityDirectory,
        currentPid: 1000,
        readPidStartedAt: async (pid) =>
          pid === 1000 ? '2026-07-31T00:00:31.000Z' : pid === 888 ? NEW_MARKER : OLD_MARKER,
        exec: async (_file, args) => {
          if (args.includes('display-message')) {
            successorReachedPreflight();
            await successorFinish;
          }
          return { stdout: '', stderr: 'unavailable', exitCode: 1 };
        },
      },
    );
    await successorInPreflight;
    allowStaleInspection();

    await expect(first).resolves.toMatchObject({ status: 'already-in-progress' });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      operationId: 'successor-operation',
      pid: 1000,
    });

    allowSuccessorToFinish();
    await expect(second).resolves.toMatchObject({
      status: 'not-eligible',
      reason: 'tmux-target-unavailable',
    });
  });

  it('builds only the fixed recipe command with exact session resume and assigned runtime id', async () => {
    const files = await fixture();
    const command = buildRestartCommand(
      files.recipe as ManagedRestartRecipeV1 & {
        binding: NonNullable<ManagedRestartRecipeV1['binding']>;
      },
    );
    expect(command).toContain(process.execPath);
    expect(command).toContain(`PI_SESSION_DECK_ASSIGNED_RUNTIME_ID=${RUNTIME_ID}`);
    expect(command).toContain(`--session ${files.recipe.binding!.sessionFile}`);
    expect(command).not.toContain('--name');
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('--continue');
  });
});
