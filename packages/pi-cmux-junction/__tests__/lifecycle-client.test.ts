import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleSnapshot } from '../extensions/cmux-junction/activity.js';
import {
  LIFECYCLE_ACK_TIMEOUT_MS,
  LifecycleClient,
  coordinatorLaunchArgs,
  decodeLifecycleAckLine,
  lifecycleClientPaths,
  prepareLifecycleTarget,
} from '../extensions/cmux-junction/lifecycle-client.js';

const fixturePath = new URL('../extensions/cmux-junction/wire-fixtures/v1.json', import.meta.url);
const wireFixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
const baselineWireSnapshot = wireFixtures.valid.find(
  (fixture: { name: string }) => fixture.name === 'initial idle snapshot',
).message;
const baselineWireAck = wireFixtures.validAcks.find(
  (fixture: { name: string }) => fixture.name === 'snapshot acknowledgement',
).message;

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

function wireSnapshot(overrides: Record<string, unknown> = {}) {
  return { ...baselineWireSnapshot, ...overrides };
}

function wireAck(message: Record<string, any>, overrides: Record<string, unknown> = {}) {
  return {
    ...baselineWireAck,
    workspaceId: message['workspaceId'],
    surfaceId: message['surfaceId'],
    sessionId: message['sessionId'],
    runtimeId: message['runtimeId'],
    pid: message['pid'],
    processStartedAt: message['processStartedAt'],
    connectionId: message['connectionId'],
    acceptedGeneration: message['ownerGeneration'] ?? 7,
    acceptedRevision: message['revision'],
    acceptedKind: message['kind'],
    ...overrides,
  };
}

class MockSocket extends EventEmitter {
  destroyed = false;
  readonly messages: any[] = [];
  constructor(
    private readonly autoAcknowledge = true,
    private readonly acceptedGeneration?: number,
    private readonly connectionOutcome: 'connect' | 'error' = 'connect',
  ) {
    super();
  }
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    super.once(event, listener);
    if (event === this.connectionOutcome) {
      queueMicrotask(() =>
        this.emit(event, event === 'error' ? new Error('asynchronous connect failure') : undefined),
      );
    }
    return this;
  }
  setEncoding() {
    return this;
  }
  write(value: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(value.trim());
    this.messages.push(message);
    callback?.();
    if (this.autoAcknowledge) queueMicrotask(() => this.acknowledgeLatest());
    return true;
  }
  acknowledgeLatest(splitAt?: number) {
    const message = this.messages.at(-1);
    if (!message) throw new Error('No message to acknowledge');
    const ack = wireAck(message, {
      acceptedGeneration: this.acceptedGeneration ?? message.ownerGeneration ?? 7,
    });
    const line = `${JSON.stringify(ack)}\n`;
    if (splitAt === undefined) {
      this.emit('data', line);
    } else {
      this.emit('data', line.slice(0, splitAt));
      this.emit('data', line.slice(splitAt));
    }
  }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

afterEach(async () => {
  vi.useRealTimers();
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
  it('matches the shared valid and invalid acknowledgement fixtures', () => {
    for (const fixture of wireFixtures.validAcks) {
      const expected = wireFixtures.valid.find(
        (candidate: { name: string }) => candidate.name === fixture.messageName,
      ).message;
      expect(
        decodeLifecycleAckLine(JSON.stringify(fixture.message), expected),
        fixture.name,
      ).not.toBeNull();
    }
    const expected = wireFixtures.valid[0].message;
    for (const fixture of wireFixtures.invalidAcks) {
      expect(
        decodeLifecycleAckLine(JSON.stringify(fixture.message), expected),
        fixture.name,
      ).toBeNull();
    }
  });

  it('decodes only the strict one-line v1 acknowledgement envelope', () => {
    const message = wireSnapshot();
    const ack = wireAck(message, { acceptedGeneration: 1 });
    expect(decodeLifecycleAckLine(JSON.stringify(ack), message)).toEqual(ack);
    const invalidFences: Array<[string, Record<string, unknown>]> = [
      ['protocol', { protocol: 'pi-junction.lifecycle.v2' }],
      ['kind', { kind: 'nack' }],
      ['workspaceId', { workspaceId: 'workspace-b' }],
      ['surfaceId', { surfaceId: 'surface-b' }],
      ['sessionId', { sessionId: 'session-b' }],
      ['runtimeId', { runtimeId: 'runtime-b' }],
      ['pid', { pid: owner.pid + 1 }],
      ['processStartedAt', { processStartedAt: owner.processStartedAt + 1 }],
      ['connectionId', { connectionId: 'connection-b' }],
      ['acceptedGeneration', { acceptedGeneration: 0 }],
      ['acceptedRevision', { acceptedRevision: 1 }],
      ['acceptedKind', { acceptedKind: 'goodbye' }],
    ];
    for (const [field, override] of invalidFences) {
      expect(
        decodeLifecycleAckLine(JSON.stringify({ ...ack, ...override }), message),
        field,
      ).toBeNull();
    }
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

  it('emits only the allowed snapshot and goodbye keys', async () => {
    const socket = new MockSocket();
    const value = client({ connect: () => socket as any });
    await value.start(snapshot);
    await value.goodbye();

    expect(Object.keys(socket.messages[0]).sort()).toEqual(
      [
        'protocol',
        'kind',
        'workspaceId',
        'surfaceId',
        'sessionId',
        'runtimeId',
        'pid',
        'processStartedAt',
        'connectionId',
        'ownerGeneration',
        'revision',
        'sentAt',
        'state',
        'toolName',
        'transitionAt',
        'lastEventAt',
        'compactionAt',
      ].sort(),
    );
    expect(Object.keys(socket.messages[1]).sort()).toEqual(
      [
        'protocol',
        'kind',
        'workspaceId',
        'surfaceId',
        'sessionId',
        'runtimeId',
        'pid',
        'processStartedAt',
        'connectionId',
        'ownerGeneration',
        'revision',
        'sentAt',
      ].sort(),
    );
  });

  it('preserves concurrent operation wire order while acknowledgements are deferred', async () => {
    const first = new MockSocket(false);
    const replacement = new MockSocket(false);
    const sockets = [first, replacement];
    const value = client({ connect: () => sockets.shift() as any });

    const registration = value.start(snapshot);
    const update = value.snapshot({ ...snapshot, state: 'thinking' });
    const sessionChange = value.changeSession('session-b');
    const sessionSnapshot = value.snapshot(snapshot);
    const disposal = value.goodbye();

    await vi.waitFor(() => expect(first.messages).toHaveLength(1));
    expect(first.messages[0]).toMatchObject({
      kind: 'snapshot',
      revision: 0,
      sessionId: 'session-a',
    });
    first.acknowledgeLatest();
    await vi.waitFor(() => expect(first.messages).toHaveLength(2));
    expect(first.messages[1]).toMatchObject({
      kind: 'snapshot',
      revision: 1,
      sessionId: 'session-a',
    });
    first.acknowledgeLatest();

    await vi.waitFor(() => expect(replacement.messages).toHaveLength(1));
    expect(replacement.messages[0]).toMatchObject({
      kind: 'snapshot',
      revision: 0,
      sessionId: 'session-b',
      ownerGeneration: null,
    });
    replacement.acknowledgeLatest();
    await vi.waitFor(() => expect(replacement.messages).toHaveLength(2));
    expect(replacement.messages[1]).toMatchObject({
      kind: 'goodbye',
      revision: 1,
      sessionId: 'session-b',
      ownerGeneration: 7,
    });
    replacement.acknowledgeLatest();

    await expect(
      Promise.all([registration, update, sessionChange, sessionSnapshot, disposal]),
    ).resolves.toEqual([true, true, undefined, true, true]);
    expect([...first.messages, ...replacement.messages].map((message) => message.kind)).toEqual([
      'snapshot',
      'snapshot',
      'snapshot',
      'goodbye',
    ]);
  });

  it('accepts an acknowledgement split across socket chunks', async () => {
    const socket = new MockSocket(false);
    const value = client({ connect: () => socket as any });
    const registration = value.start(snapshot);
    await vi.waitFor(() => expect(socket.messages).toHaveLength(1));
    socket.acknowledgeLatest(23);
    await expect(registration).resolves.toBe(true);
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

  it('releases an unacknowledged delivery and replays it exactly once after disconnect', async () => {
    const first = new MockSocket(false);
    const replacement = new MockSocket(false);
    const sockets = [first, replacement];
    const value = client({ connect: () => sockets.shift() as any });

    const registration = value.start(snapshot);
    await vi.waitFor(() => expect(first.messages).toHaveLength(1));
    first.destroy();
    await expect(registration).resolves.toBe(false);
    await vi.waitFor(() => expect(replacement.messages).toHaveLength(1));
    expect(replacement.messages[0]).toEqual({
      ...first.messages[0],
      revision: 1,
    });
    replacement.acknowledgeLatest();
    await vi.waitFor(() => expect(value.diagnostics().generation).toBe(7));
    await Promise.resolve();
    expect(replacement.messages).toHaveLength(1);
  });

  it('adopts a newly assigned generation after its prior lease was reaped', async () => {
    const firstSocket = new MockSocket();
    const reregistered = new MockSocket(true, 8);
    const sockets = [firstSocket, reregistered];
    const value = client({ connect: () => sockets.shift() as any });
    await value.start(snapshot);
    firstSocket.destroy();
    await vi.waitFor(() => expect(reregistered.messages).toHaveLength(1));
    expect(reregistered.messages[0]).toMatchObject({ ownerGeneration: 7, revision: 1 });
    expect(value.diagnostics()).toMatchObject({ generation: 8, revision: 1 });

    await value.snapshot({ ...snapshot, state: 'thinking' });
    expect(reregistered.messages[1]).toMatchObject({ ownerGeneration: 8, revision: 2 });
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

  it('launches and retries after the first socket reports an asynchronous error', async () => {
    const failed = new MockSocket(false, undefined, 'error');
    const connected = new MockSocket();
    const sockets = [failed, connected];
    const spawned = vi.fn(() => ({ unref: vi.fn() }));
    const value = client({
      spawn: spawned,
      connect: () => sockets.shift() as any,
      connectAttempts: 1,
    });

    await expect(value.start(snapshot)).resolves.toBe(true);
    expect(failed.destroyed).toBe(true);
    expect(spawned).toHaveBeenCalledOnce();
    expect(connected.messages).toHaveLength(1);
  });

  it('retries path preparation on a later snapshot after initial registration fails', async () => {
    const preparePaths = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient path failure'))
      .mockResolvedValue(undefined);
    const socket = new MockSocket();
    const connect = vi.fn(() => socket as any);
    const value = client({ preparePaths, connect });

    await expect(value.start(snapshot)).resolves.toBe(false);
    expect(connect).not.toHaveBeenCalled();
    await expect(value.snapshot({ ...snapshot, state: 'thinking' })).resolves.toBe(true);
    expect(preparePaths).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();
    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]).toMatchObject({ state: 'thinking', revision: 1 });
  });

  it('times out a silent peer, discards it, and releases the delivery queue', async () => {
    vi.useFakeTimers();
    const silent = new MockSocket(false);
    const replacement = new MockSocket();
    const sockets = [silent, replacement];
    const value = client({ connect: () => sockets.shift() as any });

    const registration = value.start(snapshot);
    const next = value.snapshot({ ...snapshot, state: 'thinking' });
    await vi.advanceTimersByTimeAsync(0);
    expect(silent.messages).toHaveLength(1);
    expect(replacement.messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(LIFECYCLE_ACK_TIMEOUT_MS);
    await expect(registration).resolves.toBe(false);
    expect(silent.destroyed).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toBe(true);
    expect(replacement.messages).toHaveLength(1);
    expect(replacement.messages[0]).toMatchObject({ state: 'thinking', revision: 1 });
  });

  it('rejects closed operations before preparing, connecting, or launching', async () => {
    const preparePaths = vi.fn(async () => undefined);
    const connect = vi.fn(() => new MockSocket() as any);
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const value = client({ preparePaths, connect, spawn });

    await expect(value.goodbye()).resolves.toBe(true);
    await expect(value.start(snapshot)).resolves.toBe(false);
    await expect(value.snapshot(snapshot)).resolves.toBe(false);
    await value.changeSession('session-b');
    expect(preparePaths).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(value.diagnostics()).toMatchObject({ generation: null, revision: -1, connected: false });
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
