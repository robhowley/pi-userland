import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachPresentationClient,
  PRESENTATION_ACK_TIMEOUT_MS,
  PRESENTATION_CONNECT_ATTEMPTS,
  PRESENTATION_CONNECT_RETRY_MS,
  PRESENTATION_HEARTBEAT_MS,
  presentationClientPaths,
  presentationCoordinatorLaunchArgs,
  preparePresentationTarget,
} from '../extensions/cmux-junction/presentation-client.js';
import {
  createPresentationAck,
  createPresentationRejection,
  PRESENTATION_PROTOCOL,
} from '../extensions/cmux-junction/presentation-protocol.mjs';
import {
  createProducerViewStore,
  type ProducerViewStore,
} from '../extensions/cmux-junction/producer-view.js';

const target = {
  socketPath: '/tmp/cmux hostile socket.sock',
  workspaceId: 'workspace --hostile',
  surfaceId: 'surface-a',
};
const source = {
  sessionId: 'session-a',
  runtimeId: 'runtime-a',
  pid: 4321,
  processStartedAt: 1_700_000_000_000,
};
const temporary: string[] = [];

function update(status: string) {
  return {
    producer: { key: 'pi-session-hygiene', label: 'Session Hygiene' },
    items: [
      { key: 'session-hygiene', title: 'Session health', status },
      { key: 'session-hygiene-cache', title: 'Cache', status: 'cache 80%' },
    ],
  };
}

class MockSocket extends EventEmitter {
  destroyed = false;
  readonly messages: Array<Record<string, any>> = [];

  constructor(
    private readonly autoAcknowledge = true,
    private readonly generation = 7,
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

  write(value: string, callback?: (error?: Error | null) => void) {
    this.messages.push(JSON.parse(value.trim()));
    callback?.();
    if (this.autoAcknowledge) queueMicrotask(() => this.acknowledgeLatest());
    return true;
  }

  acknowledgeLatest(options: { splitAt?: number; prefix?: string; suffix?: string } = {}) {
    const message = this.messages.at(-1);
    if (!message) throw new Error('No presentation message to acknowledge');
    const line = `${options.prefix ?? ''}${JSON.stringify(
      createPresentationAck(message, message['sourceGeneration'] ?? this.generation),
    )}\n${options.suffix ?? ''}`;
    if (options.splitAt === undefined) {
      this.emit('data', line);
    } else {
      this.emit('data', line.slice(0, options.splitAt));
      this.emit('data', line.slice(options.splitAt));
    }
  }

  rejectLatest(reason = 'capacity') {
    const message = this.messages.at(-1);
    if (!message) throw new Error('No presentation message to reject');
    this.emit('data', `${JSON.stringify(createPresentationRejection(message, reason))}\n`);
  }

  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

function client(
  store: ProducerViewStore,
  socket: MockSocket | (() => MockSocket),
  overrides: Record<string, unknown> = {},
) {
  return attachPresentationClient(store, {
    target,
    source,
    coordinatorPath: '/package/coordinator.mjs',
    home: '/isolated/home',
    randomId: () => 'connection-a',
    preparePaths: async () => undefined,
    connect: () => (typeof socket === 'function' ? socket() : socket) as any,
    ...overrides,
  });
}

async function waitForMessages(socket: MockSocket, count: number) {
  await vi.waitFor(() => expect(socket.messages).toHaveLength(count));
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('presentation send pump', () => {
  it('subscribes before reading and sends the meaningful empty initial snapshot', async () => {
    const calls: string[] = [];
    const store: ProducerViewStore = {
      clear: () => undefined,
      accept: () => ({ accepted: true, action: 'none' }),
      subscribe: () => {
        calls.push('subscribe');
        return () => undefined;
      },
      snapshot: () => {
        calls.push('snapshot');
        return Object.freeze([]);
      },
    };
    const socket = new MockSocket();
    const value = client(store, socket);
    await waitForMessages(socket, 1);

    expect(calls).toEqual(['subscribe', 'snapshot']);
    expect(socket.messages[0]).toEqual({
      protocol: PRESENTATION_PROTOCOL,
      kind: 'snapshot',
      workspaceId: target.workspaceId,
      surfaceId: target.surfaceId,
      sessionId: source.sessionId,
      runtimeId: source.runtimeId,
      pid: source.pid,
      processStartedAt: source.processStartedAt,
      connectionId: 'connection-a',
      sourceGeneration: null,
      revision: 0,
      views: [],
    });
    expect(socket.messages[0]).not.toHaveProperty('sentAt');
    await value.goodbye();
    expect(socket.messages.every((message) => message['protocol'] === PRESENTATION_PROTOCOL)).toBe(
      true,
    );
    expect(JSON.stringify(socket.messages)).not.toContain('pi-junction.lifecycle.v1');
  });

  it('transports producer withdrawal as a complete empty replacement snapshot', async () => {
    const store = createProducerViewStore();
    store.accept(update('🟢 ctx ok'));
    const socket = new MockSocket();
    const value = client(store, socket);
    await waitForMessages(socket, 1);
    expect(socket.messages[0]!['views']).toHaveLength(1);

    store.accept({ ...update('🟢 ctx ok'), items: [] });
    await waitForMessages(socket, 2);
    expect(socket.messages[1]).toMatchObject({ kind: 'snapshot', revision: 1, views: [] });
    await value.goodbye();
  });

  it('keeps one in-flight send and coalesces delayed-ACK updates to the latest snapshot', async () => {
    const store = createProducerViewStore();
    const socket = new MockSocket(false);
    const value = client(store, socket);
    await waitForMessages(socket, 1);

    store.accept(update('🟡 ctx watch'));
    store.accept(update('🔴 ctx compact'));
    expect(socket.messages).toHaveLength(1);
    socket.acknowledgeLatest();
    await waitForMessages(socket, 2);
    expect(socket.messages[1]!['views'][0].items[0].status).toBe('🔴 ctx compact');
    expect(socket.messages.map((message) => message['revision'])).toEqual([0, 1]);
    socket.acknowledgeLatest();
    const goodbye = value.goodbye();
    await waitForMessages(socket, 3);
    socket.acknowledgeLatest();
    await goodbye;
  });

  it('keeps a rejected latest snapshot dirty and retries only on the next heartbeat', async () => {
    vi.useFakeTimers();
    const store = createProducerViewStore();
    const socket = new MockSocket(false);
    const value = client(store, socket);
    await vi.advanceTimersByTimeAsync(0);
    socket.acknowledgeLatest();
    await vi.advanceTimersByTimeAsync(0);

    store.accept(update('🟡 ctx watch'));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.messages[1]).toMatchObject({ revision: 1, sourceGeneration: 7 });
    socket.rejectLatest('capacity');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.messages).toHaveLength(2);
    expect(value.diagnostics().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(PRESENTATION_HEARTBEAT_MS);
    expect(socket.messages[2]).toMatchObject({ revision: 2, sourceGeneration: 7 });
    socket.acknowledgeLatest();
    await vi.advanceTimersByTimeAsync(0);
    const goodbye = value.goodbye();
    await vi.advanceTimersByTimeAsync(0);
    socket.acknowledgeLatest();
    await goodbye;
  });

  it('parses split and coalesced replies and disconnects after three malformed replies', async () => {
    const store = createProducerViewStore();
    const first = new MockSocket(false);
    const replacement = new MockSocket(false);
    const sockets = [first, replacement];
    const value = client(store, () => sockets.shift()!);
    await waitForMessages(first, 1);
    first.acknowledgeLatest({ splitAt: 23, suffix: 'ignored-without-request\n' });
    await vi.waitFor(() => expect(value.diagnostics().generation).toBe(7));

    store.accept(update('🟡 ctx watch'));
    await waitForMessages(first, 2);
    first.emit('data', 'bad\nstill-bad\nalso-bad\n');
    await waitForMessages(replacement, 1);
    expect(first.destroyed).toBe(true);
    expect(replacement.messages[0]).toMatchObject({ revision: 2, sourceGeneration: 7 });
    replacement.acknowledgeLatest({ prefix: 'bad\n' });
    await vi.waitFor(() => expect(value.diagnostics().dirty).toBe(false));
    const goodbye = value.goodbye();
    await waitForMessages(replacement, 2);
    replacement.acknowledgeLatest();
    await goodbye;
  });

  it('reconnects with the stable connection ID and replays only the latest full snapshot', async () => {
    const store = createProducerViewStore();
    store.accept(update('🟡 ctx watch'));
    const first = new MockSocket();
    const replacement = new MockSocket();
    const sockets = [first, replacement];
    const value = client(store, () => sockets.shift()!);
    await waitForMessages(first, 1);
    store.accept(update('🔴 ctx compact'));
    await waitForMessages(first, 2);

    first.destroy();
    await waitForMessages(replacement, 1);
    expect(replacement.messages[0]).toMatchObject({
      connectionId: 'connection-a',
      sourceGeneration: 7,
      revision: 2,
    });
    expect(replacement.messages[0]!['views'][0].items[0].status).toBe('🔴 ctx compact');

    first.emit('data', `${JSON.stringify(createPresentationAck(first.messages[0], 99))}\n`);
    first.emit('close');
    expect(value.diagnostics().generation).toBe(7);
    expect(replacement.messages).toHaveLength(1);
    await value.goodbye();
  });

  it('sends a dirty snapshot before one fenced goodbye during shutdown', async () => {
    const store = createProducerViewStore();
    const socket = new MockSocket(false);
    const value = client(store, socket);
    await waitForMessages(socket, 1);
    store.accept(update('🟡 ctx watch'));
    const goodbye = value.goodbye();

    socket.acknowledgeLatest();
    await waitForMessages(socket, 2);
    expect(socket.messages[1]).toMatchObject({ kind: 'snapshot', revision: 1 });
    socket.acknowledgeLatest();
    await waitForMessages(socket, 3);
    expect(socket.messages[2]).toMatchObject({
      kind: 'goodbye',
      sourceGeneration: 7,
      revision: 2,
    });
    expect(socket.messages[2]).not.toHaveProperty('views');
    socket.acknowledgeLatest();
    await expect(goodbye).resolves.toBe(true);
    expect(socket.destroyed).toBe(true);
  });
});

describe('presentation sessions and transport lifetime', () => {
  it('heartbeats the complete latest snapshot every 10 seconds', async () => {
    vi.useFakeTimers();
    const store = createProducerViewStore();
    store.accept(update('🟢 ctx ok'));
    const socket = new MockSocket();
    const value = client(store, socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PRESENTATION_HEARTBEAT_MS - 1);
    expect(socket.messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.messages[1]).toMatchObject({ kind: 'snapshot', revision: 1 });
    expect(socket.messages[1]!['views']).toEqual(socket.messages[0]!['views']);
    const goodbye = value.goodbye();
    await vi.advanceTimersByTimeAsync(0);
    await goodbye;
  });

  it('best-effort goodbyes the old session then resets connection, generation, and revision', async () => {
    const store = createProducerViewStore();
    const oldSocket = new MockSocket();
    const newSocket = new MockSocket();
    const sockets = [oldSocket, newSocket];
    const ids = ['connection-a', 'connection-b'];
    const value = client(store, () => sockets.shift()!, { randomId: () => ids.shift()! });
    await waitForMessages(oldSocket, 1);
    await value.changeSession('session-b');
    await waitForMessages(newSocket, 1);

    expect(oldSocket.messages.map((message) => message['kind'])).toEqual(['snapshot', 'goodbye']);
    expect(oldSocket.messages[1]).toMatchObject({
      sessionId: 'session-a',
      connectionId: 'connection-a',
      sourceGeneration: 7,
      revision: 1,
    });
    expect(newSocket.messages[0]).toMatchObject({
      sessionId: 'session-b',
      connectionId: 'connection-b',
      sourceGeneration: null,
      revision: 0,
    });
    await value.goodbye();
  });

  it('times out ACKs at two seconds and bounds coordinator connection attempts', async () => {
    vi.useFakeTimers();
    const store = createProducerViewStore();
    const silent = new MockSocket(false);
    const replacement = new MockSocket();
    const sockets = [silent, replacement];
    const value = client(store, () => sockets.shift()!);
    await vi.advanceTimersByTimeAsync(0);
    expect(silent.messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PRESENTATION_ACK_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.messages[0]).toMatchObject({ revision: 1 });
    const goodbye = value.goodbye();
    await vi.advanceTimersByTimeAsync(0);
    await goodbye;

    const attempts = vi.fn(() => {
      throw new Error('absent');
    });
    const bounded = client(createProducerViewStore(), attempts as never, {
      connect: attempts,
      connectAttempts: 2,
      connectRetryMs: PRESENTATION_CONNECT_RETRY_MS,
      spawn: () => ({ unref: () => undefined }),
    });
    await vi.advanceTimersByTimeAsync(PRESENTATION_CONNECT_RETRY_MS * 2);
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(PRESENTATION_CONNECT_ATTEMPTS).toBe(20);
    const boundedGoodbye = bounded.goodbye();
    await vi.runAllTimersAsync();
    await boundedGoodbye;
  });
});

describe('presentation coordinator election and private paths', () => {
  it('launches lockf with exact shell-free argv', async () => {
    const store = createProducerViewStore();
    const socket = new MockSocket();
    const spawned = vi.fn(() => ({ unref: vi.fn() }));
    let attempt = 0;
    const value = attachPresentationClient(store, {
      target,
      source,
      coordinatorPath: '/package/coordinator.mjs',
      home: '/isolated/home',
      randomId: () => 'connection-a',
      preparePaths: async () => undefined,
      spawn: spawned,
      connect: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('absent');
        return socket as any;
      },
    });
    await waitForMessages(socket, 1);
    const paths = presentationClientPaths(target, '/isolated/home');
    expect(spawned).toHaveBeenCalledWith(
      '/usr/bin/lockf',
      presentationCoordinatorLaunchArgs(paths, target, '/package/coordinator.mjs'),
      expect.objectContaining({ shell: false, detached: true, stdio: 'ignore' }),
    );
    await value.goodbye();
  });

  it('reuses the shared coordinator path while preserving 0700/0600 private access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-junction-presentation-'));
    temporary.push(home);
    const paths = presentationClientPaths(target, home);
    expect(paths.directory).toContain('/lifecycle/');
    await preparePresentationTarget(paths);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.lockPath)).mode & 0o777).toBe(0o600);
  });
});
