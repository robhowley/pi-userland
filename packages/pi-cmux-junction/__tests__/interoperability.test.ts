import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { LifecycleSnapshot } from '../extensions/cmux-junction/activity.js';
import { runCoordinatorRuntime } from '../extensions/cmux-junction/coordinator.mjs';
import { LifecycleClient } from '../extensions/cmux-junction/lifecycle-client.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('interoperates across the real client and coordinator Unix socket protocol', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-junction-interop-'));
  temporaryDirectories.push(directory);
  const listen = join(directory, 'coordinator.sock');
  const ledger = join(directory, 'ledger.json');
  const target = {
    socketPath: '/tmp/injected-cmux.sock',
    workspaceId: 'workspace-interop',
    surfaceId: 'surface-interop',
  };
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const published: Array<{ state: string | null; label: string | null }> = [];
  let now = 1_700_000_001_000;
  const runtime = await runCoordinatorRuntime(
    [
      '--listen',
      listen,
      '--ledger',
      ledger,
      '--cmux-socket',
      target.socketPath,
      '--workspace',
      target.workspaceId,
    ],
    {
      now: () => now,
      probePid: () => 'match',
      randomId: () => 'coordinator-socket-token',
      schedule: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
      publish: async (status: { state: string | null; label: string | null }) => {
        published.push(status);
        return { ok: true };
      },
    },
  );
  const client = new LifecycleClient({
    target,
    owner: {
      sessionId: 'session-interop',
      runtimeId: 'runtime-interop',
      pid: 4321,
      processStartedAt: 1_700_000_000_000,
    },
    coordinatorPath: '/unused/coordinator.mjs',
    now: () => now,
    randomId: () => 'client-connection-id',
    createPaths: () => ({
      directory,
      lockPath: join(directory, 'lock'),
      socketPath: listen,
      ledgerPath: ledger,
    }),
    preparePaths: async () => undefined,
  });

  const idle: LifecycleSnapshot = {
    state: 'idle',
    toolName: null,
    transitionAt: now,
    lastEventAt: null,
    compaction: null,
  };

  try {
    await expect(client.start(idle)).resolves.toBe(true);
    await runtime.core.drain();

    now += 1_000;
    await expect(
      client.snapshot({
        state: 'tool-running',
        toolName: 'bash',
        transitionAt: now,
        lastEventAt: now,
        compaction: null,
      }),
    ).resolves.toBe(true);
    await runtime.core.drain();

    now += 1_000;
    await expect(
      client.snapshot({
        state: 'compacting',
        toolName: null,
        transitionAt: now,
        lastEventAt: now,
        compaction: { at: now, stale: false },
      }),
    ).resolves.toBe(true);
    await runtime.core.drain();

    await expect(client.goodbye()).resolves.toBe(true);
    await runtime.core.drain();
    expect(client.diagnostics()).toMatchObject({ generation: 1, revision: 3 });
    expect(published).toEqual([
      { state: 'idle', label: 'Idle' },
      { state: 'tool-running', label: 'Tool running: bash' },
      { state: 'compacting', label: 'Compacting' },
    ]);

    const serverClosed = once(runtime.server, 'close');
    now += 5_000;
    scheduled.shift()!.callback();
    await runtime.core.drain();
    await serverClosed;
    expect(published.at(-1)).toEqual({ state: null, label: null });
  } finally {
    if (runtime.server.listening) {
      const serverClosed = once(runtime.server, 'close');
      runtime.close();
      await serverClosed;
    }
  }
});
