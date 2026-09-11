import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createConnection, type Socket } from 'node:net';
import type { NormalizedProducerView, ProducerViewStore } from './producer-view.js';
import {
  coordinatorLaunchArgs,
  lifecycleClientPaths,
  prepareLifecycleTarget,
  type LifecycleClientPaths,
  type LifecycleTarget,
} from './lifecycle-client.js';
import {
  decodePresentationResponseLine,
  MAX_PRESENTATION_REQUEST_LINE_BYTES,
  MAX_PRESENTATION_RESPONSE_LINE_BYTES,
  PRESENTATION_PROTOCOL,
} from './presentation-protocol.mjs';

export { PRESENTATION_PROTOCOL };
export const PRESENTATION_ACK_TIMEOUT_MS = 2_000;
export const PRESENTATION_HEARTBEAT_MS = 10_000;
export const PRESENTATION_CONNECT_ATTEMPTS = 20;
export const PRESENTATION_CONNECT_RETRY_MS = 50;
export const MAX_PRESENTATION_MALFORMED_REPLIES = 3;

export type PresentationTarget = LifecycleTarget;
export type PresentationClientPaths = LifecycleClientPaths;
export const presentationClientPaths = lifecycleClientPaths;
export const preparePresentationTarget = prepareLifecycleTarget;
export const presentationCoordinatorLaunchArgs = coordinatorLaunchArgs;

export interface PresentationSourceIdentity {
  sessionId: string;
  runtimeId: string;
  pid: number;
  processStartedAt: number;
}

interface SnapshotMessage {
  protocol: typeof PRESENTATION_PROTOCOL;
  kind: 'snapshot';
  workspaceId: string;
  surfaceId: string;
  sessionId: string;
  runtimeId: string;
  pid: number;
  processStartedAt: number;
  connectionId: string;
  sourceGeneration: number | null;
  revision: number;
  views: readonly NormalizedProducerView[];
}

interface GoodbyeMessage extends Omit<SnapshotMessage, 'kind' | 'views' | 'sourceGeneration'> {
  kind: 'goodbye';
  sourceGeneration: number;
}

type WireMessage = SnapshotMessage | GoodbyeMessage;

type PresentationResponse =
  | {
      kind: 'ack';
      acceptedGeneration: number;
      acceptedRevision: number;
      acceptedKind: WireMessage['kind'];
    }
  | {
      kind: 'rejection';
      rejectedGeneration: number | null;
      rejectedRevision: number;
      rejectedKind: WireMessage['kind'];
      reason: string;
    };

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

export interface PresentationClientOptions {
  descriptionReservation?: import('./config.js').DescriptionReservation;
  target: PresentationTarget;
  source: PresentationSourceIdentity;
  coordinatorPath: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  randomId?: () => string;
  spawn?: SpawnProcess;
  connect?: ConnectSocket;
  createPaths?: (target: PresentationTarget, home: string) => PresentationClientPaths;
  preparePaths?: (paths: PresentationClientPaths) => Promise<void>;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  connectAttempts?: number;
  connectRetryMs?: number;
}

export interface PresentationClient {
  changeSession(sessionId: string): Promise<void>;
  goodbye(): Promise<boolean>;
  diagnostics(): {
    generation: number | null;
    revision: number;
    connected: boolean;
    dirty: boolean;
  };
}

export function attachPresentationClient(
  store: ProducerViewStore,
  options: PresentationClientOptions,
): PresentationClient {
  const client = new AttachedPresentationClient(options);
  client.attach(store);
  return client;
}

class AttachedPresentationClient implements PresentationClient {
  private readonly options: Required<
    Pick<
      PresentationClientOptions,
      | 'randomId'
      | 'spawn'
      | 'connect'
      | 'createPaths'
      | 'preparePaths'
      | 'setTimeout'
      | 'clearTimeout'
      | 'setInterval'
      | 'clearInterval'
    >
  > &
    PresentationClientOptions;
  private readonly paths: PresentationClientPaths;
  private sessionId: string;
  private connectionId: string;
  private sourceGeneration: number | null = null;
  private revision = -1;
  private latestViews: readonly NormalizedProducerView[] = Object.freeze([]);
  private dirty = false;
  private closing = false;
  private resetting = false;
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private socket: Socket | null = null;
  private connectPromise: Promise<Socket | null> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private triggerNumber = 0;
  private lastAttemptTrigger = -1;
  private waiting: {
    socket: Socket;
    message: WireMessage;
    resolve: (response: PresentationResponse | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private buffer = '';
  private malformedReplies = 0;
  private goodbyePromise: Promise<boolean> | null = null;

  constructor(options: PresentationClientOptions) {
    this.options = {
      ...options,
      randomId: options.randomId ?? randomUUID,
      spawn:
        options.spawn ?? ((file, args, spawnOptions) => nodeSpawn(file, [...args], spawnOptions)),
      connect: options.connect ?? ((path) => createConnection(path)),
      createPaths: options.createPaths ?? presentationClientPaths,
      preparePaths: options.preparePaths ?? preparePresentationTarget,
      setTimeout: options.setTimeout ?? globalThis.setTimeout,
      clearTimeout: options.clearTimeout ?? globalThis.clearTimeout,
      setInterval: options.setInterval ?? globalThis.setInterval,
      clearInterval: options.clearInterval ?? globalThis.clearInterval,
    };
    this.sessionId = options.source.sessionId;
    this.connectionId = this.options.randomId();
    this.paths = this.options.createPaths(options.target, options.home ?? homedir());
  }

  attach(store: ProducerViewStore): void {
    this.unsubscribe = store.subscribe((views) => this.replaceLatest(views));
    this.latestViews = store.snapshot();
    this.dirty = true;
    this.heartbeat = this.options.setInterval(() => {
      if (this.closing || this.resetting) return;
      this.dirty = true;
      this.trigger();
    }, PRESENTATION_HEARTBEAT_MS);
    this.trigger();
  }

  async changeSession(sessionId: string): Promise<void> {
    if (this.closing || sessionId === this.sessionId) return;
    this.resetting = true;
    await this.waitForPump();
    if (this.closing) {
      this.resetting = false;
      return;
    }
    if (this.sourceGeneration !== null) {
      await this.deliver(this.createGoodbye());
    }
    this.disconnect(false);
    this.sessionId = sessionId;
    this.connectionId = this.options.randomId();
    this.sourceGeneration = null;
    this.revision = -1;
    this.dirty = true;
    this.resetting = false;
    this.trigger();
  }

  goodbye(): Promise<boolean> {
    if (this.goodbyePromise) return this.goodbyePromise;
    this.closing = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat !== null) this.options.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.goodbyePromise = this.finishGoodbye();
    return this.goodbyePromise;
  }

  diagnostics() {
    return {
      generation: this.sourceGeneration,
      revision: this.revision,
      connected: this.socket !== null && !this.socket.destroyed,
      dirty: this.dirty,
    };
  }

  private replaceLatest(views: readonly NormalizedProducerView[]): void {
    if (this.closing) return;
    this.latestViews = views;
    this.dirty = true;
    this.trigger();
  }

  private trigger(): void {
    this.triggerNumber += 1;
    if (this.closing || this.resetting || this.pumpPromise) return;
    const pump = this.runPump();
    this.pumpPromise = pump;
    void pump.finally(() => {
      if (this.pumpPromise !== pump) return;
      this.pumpPromise = null;
      if (
        this.dirty &&
        !this.closing &&
        !this.resetting &&
        this.triggerNumber > this.lastAttemptTrigger
      ) {
        this.trigger();
      }
    });
  }

  private async runPump(): Promise<void> {
    while (this.dirty && !this.closing && !this.resetting) {
      this.lastAttemptTrigger = this.triggerNumber;
      this.dirty = false;
      const delivered = await this.deliver(this.createSnapshot());
      if (!delivered) {
        this.dirty = true;
        if (this.triggerNumber <= this.lastAttemptTrigger) return;
      }
    }
  }

  private async waitForPump(): Promise<void> {
    while (this.pumpPromise) await this.pumpPromise;
  }

  private async finishGoodbye(): Promise<boolean> {
    await this.waitForPump();
    let snapshotDelivered = true;
    if (this.dirty) {
      this.dirty = false;
      snapshotDelivered = await this.deliver(this.createSnapshot());
      if (!snapshotDelivered) this.dirty = true;
    }
    let goodbyeDelivered = true;
    if (this.sourceGeneration !== null) {
      goodbyeDelivered = await this.deliver(this.createGoodbye());
    }
    this.disconnect(false);
    return snapshotDelivered && goodbyeDelivered;
  }

  private createSnapshot(): SnapshotMessage {
    this.revision += 1;
    return {
      ...this.common('snapshot'),
      kind: 'snapshot',
      sourceGeneration: this.sourceGeneration,
      views: this.latestViews,
    };
  }

  private createGoodbye(): GoodbyeMessage {
    const generation = this.sourceGeneration;
    if (generation === null) throw new Error('goodbye requires an accepted generation');
    this.revision += 1;
    return {
      ...this.common('goodbye'),
      kind: 'goodbye',
      sourceGeneration: generation,
    };
  }

  private common(kind: WireMessage['kind']) {
    return {
      protocol: PRESENTATION_PROTOCOL,
      kind,
      workspaceId: this.options.target.workspaceId,
      surfaceId: this.options.target.surfaceId,
      sessionId: this.sessionId,
      runtimeId: this.options.source.runtimeId,
      pid: this.options.source.pid,
      processStartedAt: this.options.source.processStartedAt,
      connectionId: this.connectionId,
      revision: this.revision,
    } as const;
  }

  private async deliver(message: WireMessage): Promise<boolean> {
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch {
      return false;
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_PRESENTATION_REQUEST_LINE_BYTES) return false;
    let socket: Socket | null;
    try {
      socket = await this.ensureConnected();
    } catch {
      return false;
    }
    if (!socket) return false;
    const response = await new Promise<PresentationResponse | null>((resolve) => {
      const timer = this.options.setTimeout(() => {
        if (this.waiting?.message !== message) return;
        this.waiting = null;
        resolve(null);
        this.disconnect(true);
      }, PRESENTATION_ACK_TIMEOUT_MS);
      this.waiting = { socket, message, resolve, timer };
      const failed = (error: unknown) => {
        if (!error || this.waiting?.message !== message) return;
        this.options.clearTimeout(timer);
        this.waiting = null;
        resolve(null);
        this.disconnect(true);
      };
      try {
        socket.write(`${line}\n`, failed);
      } catch (error) {
        failed(error);
      }
    });
    if (!response || response.kind !== 'ack') return false;
    this.sourceGeneration = response.acceptedGeneration;
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
    const existing = await this.trySocket();
    if (existing) return existing;
    this.launchCoordinator();
    const attempts = this.options.connectAttempts ?? PRESENTATION_CONNECT_ATTEMPTS;
    const retryMs = this.options.connectRetryMs ?? PRESENTATION_CONNECT_RETRY_MS;
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
        this.attachSocket(socket);
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
        presentationCoordinatorLaunchArgs(
          this.paths,
          this.options.target,
          this.options.coordinatorPath,
          this.options.descriptionReservation,
        ),
        {
          shell: false,
          detached: true,
          stdio: 'ignore',
          env: { ...(this.options.env ?? process.env) },
        },
      );
      child.unref();
    } catch {
      // A later update or heartbeat retries without interrupting Pi.
    }
  }

  private pause(delay: number): Promise<void> {
    return new Promise((resolve) => this.options.setTimeout(resolve, delay));
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.buffer = '';
    this.malformedReplies = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => this.receive(socket, String(chunk)));
    socket.on('close', () => this.socketClosed(socket));
    socket.on('error', () => undefined);
  }

  private socketClosed(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.waiting?.socket === socket) {
      this.options.clearTimeout(this.waiting.timer);
      this.waiting.resolve(null);
      this.waiting = null;
    }
    if (!this.closing && !this.resetting) {
      this.dirty = true;
      this.trigger();
    }
  }

  private receive(socket: Socket, chunk: string): void {
    if (this.socket !== socket) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const pending = this.waiting;
      if (!pending || pending.socket !== socket) continue;
      const response = decodePresentationResponseLine(
        line,
        pending.message,
      ) as PresentationResponse | null;
      if (!response) {
        this.malformedReplies += 1;
        if (this.malformedReplies >= MAX_PRESENTATION_MALFORMED_REPLIES) {
          this.disconnect(true);
          return;
        }
        continue;
      }
      this.options.clearTimeout(pending.timer);
      this.waiting = null;
      pending.resolve(response);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_PRESENTATION_RESPONSE_LINE_BYTES) {
      this.disconnect(true);
    }
  }

  private disconnect(replay: boolean): void {
    const socket = this.socket;
    this.socket = null;
    if (this.waiting) {
      this.options.clearTimeout(this.waiting.timer);
      this.waiting.resolve(null);
      this.waiting = null;
    }
    socket?.destroy();
    if (replay && !this.closing && !this.resetting) {
      this.dirty = true;
      this.trigger();
    }
  }
}
