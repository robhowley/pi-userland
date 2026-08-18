import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import {
  LIFECYCLE_TIMINGS,
  createLifecycleState,
  deriveLifecycleSnapshot,
  reduceLifecycle,
  type LifecycleEvent,
  type LifecycleReducerState,
  type LifecycleSnapshot,
  type LifecycleUiWaitKind,
} from './activity.js';
import {
  LifecycleClient,
  type LifecycleClientOptions,
  type LifecycleOwnerIdentity,
  type LifecycleTarget,
} from './lifecycle-client.js';

export const LIFECYCLE_DISABLED_ENV = 'PI_CMUX_JUNCTION_LIFECYCLE_DISABLED';
export const LIFECYCLE_HEARTBEAT_MS = 10_000;

const RUNTIME_ID_KEY = Symbol.for('pi-cmux-junction.lifecycle.runtime-id.v1');
const UI_INSTALLATION_KEY = Symbol.for('pi-cmux-junction.lifecycle.ui-installation.v1');

type LifecycleContext = ExtensionContext & { mode?: string };
interface LifecyclePublicEvent {
  source?: string;
  message?: { role?: string; stopReason?: string };
  turnIndex?: number;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  partialResult?: unknown;
  isError?: boolean;
  reason?: string;
  willRetry?: boolean;
  signal?: AbortSignal;
}
type LifecycleHandler = (event: LifecyclePublicEvent, ctx: LifecycleContext) => unknown;
type LifecyclePi = { on(event: string, handler: LifecycleHandler): void };
type IntervalHandle = ReturnType<typeof setInterval>;

export interface LifecycleEligibility {
  eligible: boolean;
  reason: 'eligible' | 'mode' | 'socket' | 'workspace' | 'surface' | 'session' | 'ci' | 'disabled';
  target?: LifecycleTarget;
  sessionId?: string;
}

export interface LifecycleDeliveryClient {
  start(snapshot: LifecycleSnapshot): Promise<boolean>;
  snapshot(snapshot: LifecycleSnapshot): Promise<boolean>;
  changeSession(sessionId: string): Promise<void>;
  goodbye(): Promise<boolean>;
}

export interface LifecycleDependencies {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  runtimeId?: () => string;
  pid?: number;
  observeProcessStart?: (pid: number) => Promise<number | null>;
  createClient?: (options: LifecycleClientOptions) => LifecycleDeliveryClient;
  setInterval?: (callback: () => void, delay: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
  coordinatorPath?: string;
}

type UiMethod = (...args: unknown[]) => unknown;

interface UiInstallation {
  originals: Partial<Record<LifecycleUiWaitKind, UiMethod>>;
  wrappers: Partial<Record<LifecycleUiWaitKind, UiMethod>>;
}

const UI_METHODS: readonly LifecycleUiWaitKind[] = ['select', 'input', 'editor', 'confirm'];

export function lifecycleEligibility(
  ctx: LifecycleContext,
  env: NodeJS.ProcessEnv = process.env,
): LifecycleEligibility {
  if (ctx.mode !== 'tui') return { eligible: false, reason: 'mode' };
  const socketPath = inheritedIdentity(env['CMUX_SOCKET_PATH']);
  if (socketPath === null) return { eligible: false, reason: 'socket' };
  const workspaceId = inheritedIdentity(env['CMUX_WORKSPACE_ID']);
  if (workspaceId === null) return { eligible: false, reason: 'workspace' };
  const surfaceId = inheritedIdentity(env['CMUX_SURFACE_ID']);
  if (surfaceId === null) return { eligible: false, reason: 'surface' };
  const sessionId = inheritedIdentity(ctx.sessionManager.getSessionId());
  if (sessionId === null) return { eligible: false, reason: 'session' };
  if ((env['CI'] ?? '').trim() !== '') return { eligible: false, reason: 'ci' };
  if (env[LIFECYCLE_DISABLED_ENV] === '1') return { eligible: false, reason: 'disabled' };
  return {
    eligible: true,
    reason: 'eligible',
    target: { socketPath, workspaceId, surfaceId },
    sessionId,
  };
}

export async function observeProcessStartedAt(pid: number): Promise<number | null> {
  return await new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 4_096 },
      (error, stdout) => {
        if (error) return resolve(null);
        const observed = Date.parse(stdout.trim());
        resolve(Number.isFinite(observed) ? observed : null);
      },
    );
  });
}

export function processRuntimeId(create = randomUUID): string {
  const globalRecord = globalThis as typeof globalThis & { [RUNTIME_ID_KEY]?: string };
  const existing = globalRecord[RUNTIME_ID_KEY];
  if (existing) return existing;
  const runtimeId = create();
  globalRecord[RUNTIME_ID_KEY] = runtimeId;
  return runtimeId;
}

export function registerJunctionLifecycle(
  pi: ExtensionAPI,
  dependencies: LifecycleDependencies = {},
): void {
  const api = pi as unknown as LifecyclePi;
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const runtimeId = dependencies.runtimeId ?? processRuntimeId;
  const pid = dependencies.pid ?? process.pid;
  const observeStart = dependencies.observeProcessStart ?? observeProcessStartedAt;
  const createClient = dependencies.createClient ?? ((options) => new LifecycleClient(options));
  const scheduleInterval = dependencies.setInterval ?? globalThis.setInterval;
  const cancelInterval = dependencies.clearInterval ?? globalThis.clearInterval;
  const coordinatorPath =
    dependencies.coordinatorPath ?? fileURLToPath(new URL('./coordinator.mjs', import.meta.url));

  let runtime: LifecycleRuntime | null = null;

  api.on('session_start', async (_event, ctx) => {
    try {
      const previous = runtime;
      runtime = null;
      await previous?.shutdown();
      const eligibility = lifecycleEligibility(ctx, env);
      if (!eligibility.eligible || !eligibility.target || !eligibility.sessionId) return;
      const processStartedAt = await observeStart(pid);
      if (processStartedAt === null) return;
      const owner: LifecycleOwnerIdentity = {
        sessionId: eligibility.sessionId,
        runtimeId: runtimeId(),
        pid,
        processStartedAt,
      };
      const client = createClient({
        target: eligibility.target,
        owner,
        coordinatorPath,
        env,
        now,
      });
      runtime = new LifecycleRuntime({
        ctx,
        owner,
        client,
        now,
        scheduleInterval,
        cancelInterval,
      });
      await runtime.start();
    } catch {
      const failed = runtime;
      runtime = null;
      await failed?.shutdown();
    }
  });

  api.on('input', (event) => {
    if (event.source !== 'interactive' && event.source !== 'rpc' && event.source !== 'extension') {
      return;
    }
    return runtime?.deliver({ type: 'input', source: event.source });
  });
  api.on('message_end', (event) => {
    const message = event.message;
    if (message?.role !== 'user' && message?.role !== 'assistant') return;
    return runtime?.deliver({
      type: 'message_end',
      role: message.role,
      ...(message.role === 'assistant' && typeof message.stopReason === 'string'
        ? { stopReason: message.stopReason }
        : {}),
    });
  });
  api.on('turn_start', (event) => {
    if (typeof event.turnIndex !== 'number') return;
    return runtime?.deliver({
      type: 'turn_start',
      turnIndex: event.turnIndex,
      ...(typeof event.timestamp === 'number' ? { at: event.timestamp } : {}),
    });
  });
  api.on('tool_execution_start', (event) => {
    if (typeof event.toolCallId !== 'string') return;
    return runtime?.deliver({
      type: 'tool_execution_start',
      toolCallId: event.toolCallId,
      ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
    });
  });
  api.on('tool_execution_update', (event) => {
    if (typeof event.toolCallId !== 'string') return;
    return runtime?.deliver({
      type: 'tool_execution_update',
      toolCallId: event.toolCallId,
      meaningful: event.partialResult !== undefined,
    });
  });
  api.on('tool_execution_end', (event) => {
    if (typeof event.toolCallId !== 'string') return;
    return runtime?.deliver({
      type: 'tool_execution_end',
      toolCallId: event.toolCallId,
      isError: event.isError === true,
    });
  });
  api.on('turn_end', (event) => {
    if (typeof event.turnIndex !== 'number') return;
    return runtime?.deliver({ type: 'turn_end', turnIndex: event.turnIndex });
  });
  api.on('session_before_compact', async (event) => {
    const current = runtime;
    if (!current) return;
    const generation = await current.beginCompaction({
      reason:
        event.reason === 'manual' || event.reason === 'threshold' || event.reason === 'overflow'
          ? event.reason
          : null,
      ...(typeof event.willRetry === 'boolean' ? { willRetry: event.willRetry } : {}),
      aborted: event.signal?.aborted === true,
    });
    if (generation !== null && event.signal && !event.signal.aborted) {
      event.signal.addEventListener(
        'abort',
        () => current.deliver({ type: 'compaction_abort', generation }),
        { once: true },
      );
    }
  });
  api.on('session_compact', () => runtime?.deliver({ type: 'session_compact' }));
  api.on('agent_end', () => runtime?.deliver({ type: 'agent_end' }));
  api.on('agent_settled', (_event, ctx) =>
    runtime?.deliver({ type: 'agent_settled', isIdle: ctx.isIdle() }),
  );
  api.on('session_shutdown', async () => {
    const current = runtime;
    runtime = null;
    await current?.shutdown();
  });
}

class LifecycleRuntime {
  private state: LifecycleReducerState;
  private readonly owner: LifecycleOwnerIdentity;
  private readonly ctx: LifecycleContext;
  private readonly client: LifecycleDeliveryClient;
  private readonly now: () => number;
  private readonly scheduleInterval: LifecycleDependencies['setInterval'];
  private readonly cancelInterval: LifecycleDependencies['clearInterval'];
  private tail: Promise<void> = Promise.resolve();
  private intakeOpen = true;
  private maintenance: IntervalHandle | null = null;
  private heartbeat: IntervalHandle | null = null;
  private uiInstallation: UiInstallation | null = null;

  constructor(options: {
    ctx: LifecycleContext;
    owner: LifecycleOwnerIdentity;
    client: LifecycleDeliveryClient;
    now: () => number;
    scheduleInterval: NonNullable<LifecycleDependencies['setInterval']>;
    cancelInterval: NonNullable<LifecycleDependencies['clearInterval']>;
  }) {
    this.ctx = options.ctx;
    this.owner = options.owner;
    this.client = options.client;
    this.now = options.now;
    this.scheduleInterval = options.scheduleInterval;
    this.cancelInterval = options.cancelInterval;
    this.state = createLifecycleState({ runtimeId: options.owner.runtimeId, now: options.now() });
  }

  async start(): Promise<void> {
    this.uiInstallation = installUiWrappers(this.ctx.ui, (event) => this.deliver(event));
    await this.enqueue(
      {
        type: 'session_start',
        sessionId: this.owner.sessionId,
        runtimeId: this.owner.runtimeId,
      },
      true,
      true,
    );
    this.maintenance =
      this.scheduleInterval?.(() => {
        const sessionId = inheritedIdentity(this.ctx.sessionManager.getSessionId());
        if (sessionId === null) {
          void this.shutdown();
        } else {
          void this.maintain(sessionId);
        }
      }, LIFECYCLE_TIMINGS.maintenanceIntervalMs) ?? null;
    this.heartbeat =
      this.scheduleInterval?.(() => {
        void this.heartbeatNow();
      }, LIFECYCLE_HEARTBEAT_MS) ?? null;
  }

  deliver(event: LifecycleEvent): Promise<void> {
    if (!this.intakeOpen) return Promise.resolve();
    return this.enqueue(event, false, false);
  }

  async beginCompaction(
    event: Omit<Extract<LifecycleEvent, { type: 'session_before_compact' }>, 'type'>,
  ): Promise<number | null> {
    if (!this.intakeOpen) return null;
    await this.enqueue({ type: 'session_before_compact', ...event }, false, false);
    return this.state.compaction?.generation ?? null;
  }

  async shutdown(): Promise<void> {
    if (!this.intakeOpen) return;
    this.intakeOpen = false;
    if (this.maintenance) this.cancelInterval?.(this.maintenance);
    if (this.heartbeat) this.cancelInterval?.(this.heartbeat);
    this.maintenance = null;
    this.heartbeat = null;
    restoreUiWrappers(this.ctx.ui, this.uiInstallation);
    this.uiInstallation = null;
    await this.enqueue({ type: 'session_shutdown' }, true, false);
    await this.tail;
    try {
      await this.client.goodbye();
    } catch {
      // Shutdown remains bounded and fail-open at the client boundary.
    }
  }

  private maintain(sessionId: string | null): Promise<void> {
    if (!this.intakeOpen) return Promise.resolve();
    return this.append(async () => {
      const changedSession = sessionId !== null && sessionId !== this.state.sessionId;
      const transition = reduceLifecycle(
        this.state,
        { type: 'maintenance', sessionId },
        this.now(),
      );
      this.state = transition.state;
      if (changedSession && sessionId !== null) void this.client.changeSession(sessionId);
      if (transition.shouldPublish) this.safelySnapshot(transition.snapshot);
    });
  }

  private heartbeatNow(): Promise<void> {
    if (!this.intakeOpen) return Promise.resolve();
    return this.append(async () => {
      this.safelySnapshot(deriveLifecycleSnapshot(this.state, this.now()));
    });
  }

  private enqueue(event: LifecycleEvent, internal: boolean, initial: boolean): Promise<void> {
    if (!internal && !this.intakeOpen) return Promise.resolve();
    return this.append(async () => {
      const transition = reduceLifecycle(this.state, event, this.now());
      this.state = transition.state;
      if (event.type === 'session_shutdown') return;
      if (initial) {
        void this.client.start(transition.snapshot).catch(() => undefined);
      } else if (transition.shouldPublish) {
        this.safelySnapshot(transition.snapshot);
      }
    });
  }

  private append(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result.catch(() => undefined);
  }

  private safelySnapshot(snapshot: LifecycleSnapshot): void {
    void this.client.snapshot(snapshot).catch(() => undefined);
  }
}

export function installUiWrappers(
  ui: ExtensionUIContext,
  deliver: (event: LifecycleEvent) => Promise<void>,
): UiInstallation {
  const target = ui as ExtensionUIContext & { [UI_INSTALLATION_KEY]?: UiInstallation };
  const existing = target[UI_INSTALLATION_KEY];
  if (existing) return existing;
  const installation: UiInstallation = { originals: {}, wrappers: {} };
  let nextWait = 0;

  for (const kind of UI_METHODS) {
    const original = target[kind] as unknown as UiMethod;
    installation.originals[kind] = original;
    const wrapper = async function (this: unknown, ...args: unknown[]) {
      nextWait += 1;
      const waitId = `junction-${kind}-${nextWait}`;
      void deliver({ type: 'ui_wait_start', waitId, kind });
      try {
        return await Reflect.apply(original, this, args);
      } finally {
        void deliver({ type: 'ui_wait_end', waitId });
      }
    };
    installation.wrappers[kind] = wrapper;
    (target as unknown as Record<string, unknown>)[kind] = wrapper;
  }
  Object.defineProperty(target, UI_INSTALLATION_KEY, {
    configurable: true,
    value: installation,
  });
  return installation;
}

export function restoreUiWrappers(
  ui: ExtensionUIContext,
  installation: UiInstallation | null,
): void {
  if (!installation) return;
  const target = ui as ExtensionUIContext & { [UI_INSTALLATION_KEY]?: UiInstallation };
  if (target[UI_INSTALLATION_KEY] !== installation) return;
  const methods = target as unknown as Record<string, unknown>;
  for (const kind of UI_METHODS) {
    if (methods[kind] === installation.wrappers[kind]) {
      methods[kind] = installation.originals[kind];
    }
  }
  delete target[UI_INSTALLATION_KEY];
}

function inheritedIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) return null;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return value;
}
