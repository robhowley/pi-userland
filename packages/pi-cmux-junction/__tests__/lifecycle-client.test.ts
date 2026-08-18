import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleSnapshot } from '../extensions/cmux-junction/activity.js';
import {
  LifecycleClient,
  coordinatorLaunchArgs,
  decodeLifecycleAckLine,
  lifecycleClientPaths,
  prepareLifecycleTarget,
} from '../extensions/cmux-junction/lifecycle-client.js';

const target = {
  socketPath: '/tmp/cmux hostile socket.sock',
  workspaceId: 'workspace --hostile',
  surfaceId: 'surface-a',
};
const owner = {
  sessionId: 'session-a',
  runtimeId: 'runtime-a',
  pid: 4321,
  processStartedAt: 1_700_000_000_000,
};
const snapshot: LifecycleSnapshot = {
  state: 'idle',
  toolName: null,
  transitionAt: 1_700_000_000_000,
  lastEventAt: 1_700_000_000_000,
  compaction: null,
};
const temporary: string[] = [];

class MockSocket extends EventEmitter {
  destroyed = false;
  readonly messages: any[] = [];
  constructor(private readonly acknowledge = true) {
    super();
  }
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    super.once(event, listener);
    if (event === 'connect') queueMicrotask(() => this.emit('connect'));
    return this;
  }
  setEncoding() {
    return this;
  }
  write(value: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(value.trim());
    this.messages.push(message);
    callback?.();
    if (this.acknowledge) {
      const ack = {
        protocol: message.protocol,
        kind: 'ack',
        workspaceId: message.workspaceId,
        surfaceId: message.surfaceId,
        sessionId: message.sessionId,
        runtimeId: message.runtimeId,
        pid: message.pid,
        processStartedAt: message.processStartedAt,
        connectionId: message.connectionId,
        acceptedGeneration: message.ownerGeneration ?? 7,
        acceptedRevision: message.revision,
        acceptedKind: message.kind,
      };
      queueMicrotask(() => this.emit('data', `${JSON.stringify(ack)}\n`));
    }
    return true;
  }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function client(overrides: Record<string, unknown> = {}) {
  return new LifecycleClient({
    target,
    owner,
    coordinatorPath: '/package/coordinator.mjs',
    home: '/isolated/home',
    now: () => 1_700_000_001_000,
    randomId: () => 'connection-a',
    preparePaths: async () => undefined,
    ...overrides,
  });
}

describe('lifecycle client wire contract', () => {
  it('matches the shared valid and invalid acknowledgement fixtures', async () => {
    const fixturePath = new URL(
      '../extensions/cmux-junction/wire-fixtures/v1.json',
      import.meta.url,
    );
    const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
    for (const fixture of fixtures.validAcks) {
      const expected = fixtures.valid.find(
        (candidate: { name: string }) => candidate.name === fixture.messageName,
      ).message;
      expect(
        decodeLifecycleAckLine(JSON.stringify(fixture.message), expected),
        fixture.name,
      ).not.toBeNull();
    }
    const expected = fixtures.valid[0].message;
    for (const fixture of fixtures.invalidAcks) {
      expect(
        decodeLifecycleAckLine(JSON.stringify(fixture.message), expected),
        fixture.name,
      ).toBeNull();
    }
  });

  it('decodes only the strict one-line v1 acknowledgement envelope', () => {
    const message = {
      protocol: 'pi-junction.lifecycle.v1' as const,
      kind: 'snapshot' as const,
      workspaceId: target.workspaceId,
      surfaceId: target.surfaceId,
      sessionId: owner.sessionId,
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      processStartedAt: owner.processStartedAt,
      connectionId: 'connection-a',
      ownerGeneration: null,
      revision: 0,
      sentAt: 1_700_000_001_000,
      state: 'idle' as const,
      toolName: null,
      transitionAt: 1_700_000_000_000,
      lastEventAt: null,
      compactionStartedAt: null,
      compactionProgressAt: null,
    };
    const ack = {
      protocol: message.protocol,
      kind: 'ack',
      workspaceId: message.workspaceId,
      surfaceId: message.surfaceId,
      sessionId: message.sessionId,
      runtimeId: message.runtimeId,
      pid: message.pid,
      processStartedAt: message.processStartedAt,
      connectionId: message.connectionId,
      acceptedGeneration: 1,
      acceptedRevision: 0,
      acceptedKind: 'snapshot',
    };
    expect(decodeLifecycleAckLine(JSON.stringify(ack), message)).toEqual(ack);
    expect(decodeLifecycleAckLine(JSON.stringify({ acceptedGeneration: 1 }), message)).toBeNull();
    expect(decodeLifecycleAckLine(`${JSON.stringify(ack)}\n`, message)).toBeNull();
    expect(decodeLifecycleAckLine('x'.repeat(17 * 1024), message)).toBeNull();
  });

  it('closes after repeated malformed bounded frames', async () => {
    const socket = new MockSocket(false);
    const value = client({ connect: () => socket as any });
    const registration = value.start(snapshot);
    await vi.waitFor(() => expect(socket.messages).toHaveLength(1));
    socket.emit('data', 'bad\nstill-bad\nalso-bad\n');
    await expect(registration).resolves.toBe(false);
    expect(socket.destroyed).toBe(true);
  });

  it('assigns revisions, accepts coordinator generation, and sends goodbye last', async () => {
    const socket = new MockSocket();
    const value = client({ connect: () => socket as any });
    await expect(value.start(snapshot)).resolves.toBe(true);
    await expect(value.snapshot({ ...snapshot, state: 'thinking' })).resolves.toBe(true);
    await expect(value.goodbye()).resolves.toBe(true);

    expect(
      socket.messages.map(({ kind, revision, ownerGeneration }) => ({
        kind,
        revision,
        ownerGeneration,
      })),
    ).toEqual([
      { kind: 'snapshot', revision: 0, ownerGeneration: null },
      { kind: 'snapshot', revision: 1, ownerGeneration: 7 },
      { kind: 'goodbye', revision: 2, ownerGeneration: 7 },
    ]);
    expect(value.diagnostics()).toMatchObject({ generation: 7, revision: 2 });
  });

  it('reconnects with the accepted generation and a full latest snapshot', async () => {
    const firstSocket = new MockSocket();
    const reconnect = new MockSocket();
    const sockets = [firstSocket, reconnect];
    const value = client({ connect: () => sockets.shift() as any });
    await value.start(snapshot);
    firstSocket.destroy();
    await vi.waitFor(() => expect(reconnect.messages).toHaveLength(1));
    expect(reconnect.messages[0]).toMatchObject({
      kind: 'snapshot',
      ownerGeneration: 7,
      revision: 1,
      state: 'idle',
      toolName: null,
    });
    await value.snapshot({ ...snapshot, state: 'thinking', transitionAt: 1_700_000_001_000 });
    expect(reconnect.messages[1]).toMatchObject({
      kind: 'snapshot',
      ownerGeneration: 7,
      revision: 2,
      state: 'thinking',
    });
  });

  it('resets generation and revision for a changed Pi session', async () => {
    const sockets = [new MockSocket(), new MockSocket()];
    const used: MockSocket[] = [];
    const value = client({
      connect: () => {
        const socket = sockets.shift()!;
        used.push(socket);
        return socket as any;
      },
    });
    await value.start(snapshot);
    await value.changeSession('session-b');
    await value.snapshot(snapshot);
    expect(used[1]!.messages[0]).toMatchObject({
      sessionId: 'session-b',
      ownerGeneration: null,
      revision: 0,
    });
  });
});

describe('coordinator election and target paths', () => {
  it('launches lockf with exact argv and detached shell-free options', async () => {
    const spawned = vi.fn(() => ({ unref: vi.fn() }));
    let attempts = 0;
    const socket = new MockSocket();
    const value = client({
      spawn: spawned,
      connect: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('coordinator absent');
        return socket as any;
      },
    });
    await value.start(snapshot);
    const paths = lifecycleClientPaths(target, '/isolated/home');
    expect(spawned).toHaveBeenCalledWith(
      '/usr/bin/lockf',
      coordinatorLaunchArgs(paths, target, '/package/coordinator.mjs'),
      expect.objectContaining({ shell: false, detached: true, stdio: 'ignore' }),
    );
    expect(spawned.mock.results[0]!.value.unref).toHaveBeenCalled();
  });

  it('creates only an isolated 0700 target directory and 0600 lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-junction-client-'));
    temporary.push(home);
    const paths = lifecycleClientPaths(target, home);
    await prepareLifecycleTarget(paths);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.lockPath)).mode & 0o777).toBe(0o600);
  });

  it('fails open without real child, socket, cmux, or home effects', async () => {
    const value = client({
      connect: () => {
        throw new Error('socket unavailable');
      },
      spawn: () => {
        throw new Error('lockf unavailable');
      },
      connectAttempts: 1,
    });
    await expect(value.start(snapshot)).resolves.toBe(false);
    await expect(value.snapshot(snapshot)).resolves.toBe(false);
    await expect(value.goodbye()).resolves.toBe(true);
  });
});
