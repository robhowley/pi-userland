import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { close, open } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { promisify } from 'node:util';
import type { LifecycleSnapshot } from './activity.js';

export const LIFECYCLE_PROTOCOL = 'pi-junction.lifecycle.v1';
export const MAX_LIFECYCLE_FRAME_BYTES = 16 * 1024;
export const LIFECYCLE_ACK_TIMEOUT_MS = 2_000;

export interface LifecycleTarget {
  socketPath: string;
  workspaceId: string;
  surfaceId: string;
}

export interface LifecycleOwnerIdentity {
  sessionId: string;
  runtimeId: string;
  pid: number;
  processStartedAt: number;
}

export interface LifecycleAck {
  protocol: typeof LIFECYCLE_PROTOCOL;
  kind: 'ack';
  workspaceId: string;
  surfaceId: string;
  sessionId: string;
  runtimeId: string;
  pid: number;
  processStartedAt: number;
  connectionId: string;
  acceptedGeneration: number;
  acceptedRevision: number;
  acceptedKind: 'snapshot' | 'goodbye';
}

export interface LifecycleClientPaths {
  directory: string;
  lockPath: string;
  socketPath: string;
  ledgerPath: string;
}

interface SnapshotMessage {
  protocol: typeof LIFECYCLE_PROTOCOL;
  kind: 'snapshot';
  workspaceId: string;
  surfaceId: string;
  sessionId: string;
  runtimeId: string;
  pid: number;
  processStartedAt: number;
  connectionId: string;
  ownerGeneration: number | null;
  revision: number;
  sentAt: number;
  state: LifecycleSnapshot['state'];
  toolName: string | null;
  transitionAt: number;
  lastEventAt: number | null;
  compactionAt: number | null;
}

interface GoodbyeMessage {
  protocol: typeof LIFECYCLE_PROTOCOL;
  kind: 'goodbye';
  workspaceId: string;
  surfaceId: string;
  sessionId: string;
  runtimeId: string;
  pid: number;
  processStartedAt: number;
  connectionId: string;
  ownerGeneration: number;
  revision: number;
  sentAt: number;
}

type WireMessage = SnapshotMessage | GoodbyeMessage;

type SpawnProcess = (
  file: string,
  args: readonly string[],
  options: {
    shell: false;
    detached: true;
    stdio: 'ignore';
    env: NodeJS.ProcessEnv;
  },
) => Pick<ChildProcess, 'unref'>;

type ConnectSocket = (path: string) => Socket;

export interface LifecycleClientOptions {
  target: LifecycleTarget;
  owner: LifecycleOwnerIdentity;
  coordinatorPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  randomId?: () => string;
  spawn?: SpawnProcess;
  connect?: ConnectSocket;
  createPaths?: (target: LifecycleTarget, home: string) => LifecycleClientPaths;
  preparePaths?: (paths: LifecycleClientPaths) => Promise<void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  connectAttempts?: number;
  connectRetryMs?: number;
}

const closeFile = promisify(close);
const openFile = promisify(open);

export function lifecycleTargetHash(
  target: Pick<LifecycleTarget, 'socketPath' | 'workspaceId'>,
): string {
  return createHash('sha256')
    .update(`${normalize(target.socketPath)}\0${target.workspaceId}`)
    .digest('hex')
    .slice(0, 32);
}

export function lifecycleClientPaths(
  target: LifecycleTarget,
  home = homedir(),
): LifecycleClientPaths {
  const directory = join(home, '.pi', 'cmux-junction', 'lifecycle', lifecycleTargetHash(target));
  return {
    directory,
    lockPath: join(directory, 'coordinator.lock'),
    socketPath: join(directory, 'coordinator.sock'),
    ledgerPath: join(directory, 'ledger.json'),
  };
}

export async function prepareLifecycleTarget(paths: LifecycleClientPaths): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const descriptor = await openFile(paths.lockPath, 'a', 0o600);
  await closeFile(descriptor);
  await chmod(paths.lockPath, 0o600);
}

export function coordinatorLaunchArgs(
  paths: LifecycleClientPaths,
  target: Pick<LifecycleTarget, 'socketPath' | 'workspaceId'>,
  coordinatorPath: string,
): string[] {
  return [
    '-k',
    '-t',
    '0',
    paths.lockPath,
    coordinatorPath,
    '--listen',
    paths.socketPath,
    '--ledger',
    paths.ledgerPath,
    '--cmux-socket',
    target.socketPath,
    '--workspace',
    target.workspaceId,
  ];
}

export function decodeLifecycleAckLine(line: string, expected: WireMessage): LifecycleAck | null {
  if (
    typeof line !== 'string' ||
    Buffer.byteLength(line, 'utf8') > MAX_LIFECYCLE_FRAME_BYTES ||
    line.includes('\n') ||
    line.includes('\r') ||
    line.includes('\0')
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ack = value as Record<string, unknown>;
  const fields = [
    'protocol',
    'kind',
    'workspaceId',
    'surfaceId',
    'sessionId',
    'runtimeId',
    'pid',
    'processStartedAt',
    'connectionId',
    'acceptedGeneration',
    'acceptedRevision',
    'acceptedKind',
  ];
  if (!exactFields(ack, fields)) return null;
  if (
    ack['protocol'] !== LIFECYCLE_PROTOCOL ||
    ack['kind'] !== 'ack' ||
    ack['workspaceId'] !== expected.workspaceId ||
    ack['surfaceId'] !== expected.surfaceId ||
    ack['sessionId'] !== expected.sessionId ||
    ack['runtimeId'] !== expected.runtimeId ||
    ack['pid'] !== expected.pid ||
    ack['processStartedAt'] !== expected.processStartedAt ||
    ack['connectionId'] !== expected.connectionId ||
    ack['acceptedKind'] !== expected.kind ||
    !Number.isSafeInteger(ack['acceptedGeneration']) ||
    Number(ack['acceptedGeneration']) <= 0 ||
    !Number.isSafeInteger(ack['acceptedRevision']) ||
    ack['acceptedRevision'] !== expected.revision
  ) {
    return null;
  }
  return ack as unknown as LifecycleAck;
}

export class LifecycleClient {
  private readonly options: Required<
    Pick<
      LifecycleClientOptions,
      | 'now'
      | 'randomId'
      | 'spawn'
      | 'connect'
      | 'createPaths'
      | 'preparePaths'
      | 'setTimeout'
      | 'clearTimeout'
    >
  > &
    LifecycleClientOptions;
  private readonly paths: LifecycleClientPaths;
  private readonly connectionId: string;
  private sessionId: string;
  private ownerGeneration: number | null = null;
  private revision = -1;
  private latestSnapshot: SnapshotMessage | null = null;
  private socket: Socket | null = null;
  private connectPromise: Promise<Socket | null> | null = null;
  private sendTail: Promise<boolean> = Promise.resolve(true);
  private waiting: {
    message: WireMessage;
    resolve: (ack: LifecycleAck | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private buffer = '';
  private malformedFrames = 0;
  private closed = false;

  constructor(options: LifecycleClientOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      randomId: options.randomId ?? randomUUID,
      spawn:
        options.spawn ?? ((file, args, spawnOptions) => nodeSpawn(file, [...args], spawnOptions)),
      connect: options.connect ?? ((path) => createConnection(path)),
      createPaths: options.createPaths ?? lifecycleClientPaths,
      preparePaths: options.preparePaths ?? prepareLifecycleTarget,
      setTimeout: options.setTimeout ?? globalThis.setTimeout,
      clearTimeout: options.clearTimeout ?? globalThis.clearTimeout,
    };
    this.sessionId = options.owner.sessionId;
    this.connectionId = this.options.randomId();
    this.paths = this.options.createPaths(options.target, options.home ?? homedir());
  }

  start(snapshot: LifecycleSnapshot): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.enqueue(async () => {
      const message = this.createSnapshot(snapshot);
      this.latestSnapshot = message;
      return await this.deliver(message);
    });
  }

  snapshot(snapshot: LifecycleSnapshot): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.enqueue(async () => {
      const message = this.createSnapshot(snapshot);
      this.latestSnapshot = message;
      return await this.deliver(message);
    });
  }

  async changeSession(sessionId: string): Promise<void> {
    if (this.closed) return;
    await this.enqueue(async () => {
      if (sessionId === this.sessionId) return true;
      this.sessionId = sessionId;
      this.ownerGeneration = null;
      this.revision = -1;
      this.latestSnapshot = null;
      this.disconnect();
      return true;
    });
  }

  goodbye(): Promise<boolean> {
    this.closed = true;
    return this.enqueue(async () => {
      if (this.ownerGeneration === null) {
        this.disconnect();
        return true;
      }
      const message: GoodbyeMessage = {
        ...this.common('goodbye', this.revision + 1),
        kind: 'goodbye',
        ownerGeneration: this.ownerGeneration,
      };
      this.revision = message.revision;
      const delivered = await this.deliver(message);
      this.disconnect();
      return delivered;
    });
  }

  diagnostics(): { generation: number | null; revision: number; connected: boolean } {
    return {
      generation: this.ownerGeneration,
      revision: this.revision,
      connected: this.socket !== null && !this.socket.destroyed,
    };
  }

  private enqueue(operation: () => Promise<boolean>): Promise<boolean> {
    const result = this.sendTail.then(operation, operation);
    this.sendTail = result.catch(() => false);
    return result.catch(() => false);
  }

  private createSnapshot(snapshot: LifecycleSnapshot): SnapshotMessage {
    const revision = this.revision + 1;
    this.revision = revision;
    return {
      ...this.common('snapshot', revision),
      kind: 'snapshot',
      ownerGeneration: this.ownerGeneration,
      state: snapshot.state,
      toolName: snapshot.toolName,
      transitionAt: snapshot.transitionAt,
      lastEventAt: snapshot.lastEventAt,
      compactionAt: snapshot.compaction?.at ?? null,
    };
  }

  private common(kind: WireMessage['kind'], revision: number) {
    return {
      protocol: LIFECYCLE_PROTOCOL,
      kind,
      workspaceId: this.options.target.workspaceId,
      surfaceId: this.options.target.surfaceId,
      sessionId: this.sessionId,
      runtimeId: this.options.owner.runtimeId,
      pid: this.options.owner.pid,
      processStartedAt: this.options.owner.processStartedAt,
      connectionId: this.connectionId,
      ownerGeneration: this.ownerGeneration,
      revision,
      sentAt: this.options.now(),
    } as const;
  }

  private async deliver(message: WireMessage): Promise<boolean> {
    const socket = await this.ensureConnected();
    if (!socket) return false;
    const ack = await new Promise<LifecycleAck | null>((resolve) => {
      const timer = this.options.setTimeout(() => {
        if (this.waiting?.message === message) this.waiting = null;
        resolve(null);
        this.disconnect();
      }, LIFECYCLE_ACK_TIMEOUT_MS);
      this.waiting = { message, resolve, timer };
      socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error && this.waiting?.message === message) {
          this.options.clearTimeout(timer);
          this.waiting = null;
          resolve(null);
          this.disconnect();
        }
      });
    });
    if (!ack) return false;
    this.ownerGeneration = ack.acceptedGeneration;
    if (this.latestSnapshot) this.latestSnapshot.ownerGeneration = ack.acceptedGeneration;
    return true;
  }

  private async ensureConnected(): Promise<Socket | null> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connectPromise) return await this.connectPromise;
    this.connectPromise = this.openSocket();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async openSocket(): Promise<Socket | null> {
    try {
      await this.options.preparePaths(this.paths);
    } catch {
      return null;
    }
    const first = await this.trySocket();
    if (first) return first;
    this.launchCoordinator();
    const attempts = this.options.connectAttempts ?? 20;
    const retryMs = this.options.connectRetryMs ?? 50;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.pause(retryMs);
      const socket = await this.trySocket();
      if (socket) return socket;
    }
    return null;
  }

  private trySocket(): Promise<Socket | null> {
    return new Promise((resolve) => {
      let settled = false;
      let socket: Socket;
      try {
        socket = this.options.connect(this.paths.socketPath);
      } catch {
        resolve(null);
        return;
      }
      const finish = (value: Socket | null) => {
        if (settled) return;
        settled = true;
        socket.removeListener('connect', connected);
        socket.removeListener('error', failed);
        resolve(value);
      };
      const connected = () => {
        this.attach(socket);
        finish(socket);
      };
      const failed = () => {
        socket.destroy();
        finish(null);
      };
      socket.once('connect', connected);
      socket.once('error', failed);
    });
  }

  private launchCoordinator(): void {
    try {
      const child = this.options.spawn(
        '/usr/bin/lockf',
        coordinatorLaunchArgs(this.paths, this.options.target, this.options.coordinatorPath),
        {
          shell: false,
          detached: true,
          stdio: 'ignore',
          env: { ...(this.options.env ?? process.env) },
        },
      );
      child.unref();
    } catch {
      // Delivery remains fail-open; a later client heartbeat retries the socket.
    }
  }

  private pause(delay: number): Promise<void> {
    return new Promise((resolve) => this.options.setTimeout(resolve, delay));
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.buffer = '';
    this.malformedFrames = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => this.receive(String(chunk)));
    socket.on('close', () => {
      const wasCurrent = this.socket === socket;
      if (wasCurrent) this.socket = null;
      if (wasCurrent && this.waiting) {
        this.options.clearTimeout(this.waiting.timer);
        this.waiting.resolve(null);
        this.waiting = null;
      }
      if (wasCurrent && !this.closed && this.latestSnapshot) void this.replayLatest();
    });
    socket.on('error', () => undefined);
  }

  private replayLatest(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.closed || !this.latestSnapshot) return false;
      const message: SnapshotMessage = {
        ...this.latestSnapshot,
        ownerGeneration: this.ownerGeneration,
        revision: this.revision + 1,
        sentAt: this.options.now(),
      };
      this.revision = message.revision;
      this.latestSnapshot = message;
      return await this.deliver(message);
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LIFECYCLE_FRAME_BYTES * 2) {
      this.disconnect();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const pending = this.waiting;
      if (!pending) continue;
      const ack = decodeLifecycleAckLine(line, pending.message);
      if (!ack) {
        this.malformedFrames += 1;
        if (this.malformedFrames >= 3) this.disconnect();
        continue;
      }
      this.options.clearTimeout(pending.timer);
      this.waiting = null;
      pending.resolve(ack);
    }
  }

  private disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (this.waiting) {
      this.options.clearTimeout(this.waiting.timer);
      this.waiting.resolve(null);
      this.waiting = null;
    }
    socket?.destroy();
  }
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}
