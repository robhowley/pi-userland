import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionIdentityRecord } from '../../extensions/session-deck/identity/types.js';
import { bindManagedRestartRecipe } from '../../extensions/session-deck/restart/recipe.js';
import {
  readRestartRecipe,
  writeRestartRecipe,
} from '../../extensions/session-deck/restart/store.js';

const RUNTIME_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('managed restart recipe binding', () => {
  it('binds only matching session, cwd, pane, socket, and OS process generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-deck-recipe-bind-'));
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
          socketSelector: 'path:/tmp/tmux-501/private',
          sessionName: 'pi-project',
          windowIndex: 0,
          paneIndex: 0,
        },
        createdAt: '2026-07-31T00:00:00.000Z',
      },
      directory,
    );
    const identity = {
      runtimeId: RUNTIME_ID,
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      cwd: '/tmp/project',
      terminal: {
        kind: 'tmux',
        socketPath: '/tmp/tmux-501/private',
        sessionName: 'pi-project',
        windowIndex: 0,
        paneIndex: 0,
        panePid: 42,
      },
      runtimeSignals: { process: { pid: 42, ancestors: [] } },
      sessionHeader: {
        id: 'session-1',
        cwd: '/tmp/project',
        timestamp: '2026-07-31T00:00:00.000Z',
      },
    } as unknown as SessionIdentityRecord;

    expect(
      await bindManagedRestartRecipe(identity, {
        directory,
        readPidStartedAt: async () => '2026-07-31T00:00:01.000Z',
        now: () => new Date('2026-07-31T00:00:02.000Z'),
      }),
    ).toBe(true);
    expect(await readRestartRecipe(RUNTIME_ID, directory)).toMatchObject({
      binding: {
        sessionId: 'session-1',
        sessionFile: '/tmp/session-1.jsonl',
        pid: 42,
        osProcessStartedAt: '2026-07-31T00:00:01.000Z',
      },
    });

    const nextSessionIdentity = {
      ...identity,
      sessionId: 'session-2',
      sessionFile: '/tmp/session-2.jsonl',
      sessionHeader: { ...identity.sessionHeader!, id: 'session-2' },
    } as SessionIdentityRecord;
    expect(
      await bindManagedRestartRecipe(nextSessionIdentity, {
        directory,
        readPidStartedAt: async () => '2026-07-31T00:00:01.000Z',
      }),
    ).toBe(true);
    expect(await readRestartRecipe(RUNTIME_ID, directory)).toMatchObject({
      binding: { sessionId: 'session-2', sessionFile: '/tmp/session-2.jsonl', pid: 42 },
    });

    expect(
      await bindManagedRestartRecipe(
        {
          ...nextSessionIdentity,
          sessionId: 'session-3',
          sessionFile: '/tmp/session-3.jsonl',
          terminal: { ...identity.terminal!, panePid: 43 },
          runtimeSignals: { process: { pid: 43, ancestors: [] } },
          sessionHeader: { ...identity.sessionHeader!, id: 'session-3' },
        } as SessionIdentityRecord,
        { directory, readPidStartedAt: async () => '2026-07-31T00:00:03.000Z' },
      ),
    ).toBe(false);

    expect(
      await bindManagedRestartRecipe(
        {
          ...identity,
          terminal: { ...identity.terminal!, socketPath: '/tmp/tmux-501/other' },
        } as SessionIdentityRecord,
        { directory, readPidStartedAt: async () => '2026-07-31T00:00:03.000Z' },
      ),
    ).toBe(false);
  });
});
