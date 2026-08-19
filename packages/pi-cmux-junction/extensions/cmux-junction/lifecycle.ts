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

type LifecycleContext = ExtensionContext;
type IntervalHandle = ReturnType<typeof setInterval>;

export interface LifecycleEligibility {
  eligible: boolean;
  reason: 'eligible' | 'mode' | 'socket' | 'workspace' | 'surface' | 'session' | 'disabled';
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

  pi.on('session_start', async (_event, ctx) => {
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

  pi.on('input', (event) => {
    if (event.source !== 'interactive' && event.source !== 'rpc' && event.source !== 'extension') {
      return;
    }
    return runtime?.deliver({ type: 'input', source: event.source });
  });
  pi.on('message_end', (event) => {
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
  pi.on('agent_start', () => runtime?.deliver({ type: 'agent_start' }));
  pi.on('turn_start', (event) => {
    if (typeof event.turnIndex !== 'number') return;
    return runtime?.deliver({
      type: 'turn_start',
      turnIndex: event.turnIndex,
      ...(typeof event.timestamp === 'number' ? { at: event.timestamp } : {}),
    });
  });
  pi.on('tool_execution_start', (event) => {
    if (typeof event.toolCallId !== 'string') return;
    return runtime?.deliver({
      type: 'tool_execution_start',
      toolCallId: event.toolCallId,
      ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
    });
  });
  pi.on('tool_execution_update', (event) => {
    if (typeof event.toolCallId !== 'string') return;
    return runtime?.deliver({
      type: 'tool_execution_update',
      toolCallId: event.toolCallId,
      meaningful: isMeaningfulToolExecutionUpdate(event.partialResult),
    });
  });
  pi.on('tool_execution_end', (event) => {
    if (typeof event.toolCallId !== 'string') return;
    return runtime?.deliver({
      type: 'tool_execution_end',
      toolCallId: event.toolCallId,
    });
  });
  pi.on('turn_end', (event) => {
    if (typeof event.turnIndex !== 'number') return;
    return runtime?.deliver({ type: 'turn_end', turnIndex: event.turnIndex });
  });
  pi.on('session_before_compact', async (event) => {
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
    if (generation !== null) {
      const abort = () => current.deliver({ type: 'compaction_abort', generation });
      if (event.signal.aborted) {
        await abort();
      } else {
        event.signal.addEventListener('abort', abort, { once: true });
      }
    }
  });
  pi.on('session_compact', () => runtime?.deliver({ type: 'session_compact' }));
  pi.on('agent_settled', (_event, ctx) =>
    runtime?.deliver({ type: 'agent_settled', isIdle: ctx.isIdle() }),
  );
  pi.on('session_shutdown', async () => {
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
    const previousGeneration = this.state.compactionGeneration;
    await this.enqueue({ type: 'session_before_compact', ...event }, false, false);
    const compaction = this.state.compaction;
    return compaction !== null && compaction.generation > previousGeneration
      ? compaction.generation
      : null;
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

export function isMeaningfulToolExecutionUpdate(partialResult: unknown): boolean {
  if (!isObject(partialResult)) return hasMeaningfulToolUpdateValue(partialResult);

  return (
    hasMeaningfulToolUpdateContent(partialResult['content']) ||
    hasMeaningfulToolUpdateValue(partialResult['details']) ||
    partialResult['terminate'] === true ||
    partialResult['completed'] === true ||
    partialResult['complete'] === true ||
    partialResult['done'] === true ||
    partialResult['finished'] === true ||
    partialResult['final'] === true ||
    partialResult['isFinal'] === true ||
    partialResult['progress'] === true
  );
}

function hasMeaningfulToolUpdateContent(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some(hasMeaningfulToolUpdateContentEntry)
    : hasMeaningfulToolUpdateContentEntry(value);
}

function hasMeaningfulToolUpdateContentEntry(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!isObject(value)) return false;

  if (value['type'] === 'text') return hasMeaningfulToolUpdateValue(value['text']);
  if (value['type'] === 'image' || value['type'] === 'image_url') {
    return (
      hasMeaningfulToolUpdateValue(value['image']) ||
      hasMeaningfulToolUpdateValue(value['imageUrl']) ||
      hasMeaningfulToolUpdateValue(value['url']) ||
      hasMeaningfulToolUpdateValue(value['data'])
    );
  }
  return (
    hasMeaningfulToolUpdateValue(value['text']) ||
    hasMeaningfulToolUpdateValue(value['image']) ||
    hasMeaningfulToolUpdateValue(value['data'])
  );
}

function hasMeaningfulToolUpdateValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasMeaningfulToolUpdateValue);
  if (!isObject(value)) return false;
  return Object.values(value).some(hasMeaningfulToolUpdateValue);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
