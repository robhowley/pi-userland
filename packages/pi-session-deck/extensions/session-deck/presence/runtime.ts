import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { resolvePresenceThresholds } from './constants.js';
import { writePresenceRecord } from './writer.js';
import type { PresenceDiagnostic, PresenceRecord, PresenceThresholds } from './types.js';

const PRESENCE_RUNTIME_STATE_KEY = '__piSessionDeckPresenceRuntimeState__';

export interface PresenceRuntimeIdentity {
  runtimeId: string;
  pid: number;
  startedAt: string;
}

export type PresenceRuntimeStartup =
  | {
      state: 'healthy';
    }
  | {
      state: 'degraded';
      diagnostic: PresenceDiagnostic;
    };

export interface PresenceRuntimeStartOptions {
  directory?: string;
  now?: () => Date;
  pid?: number;
  randomUUID?: () => string;
  thresholds?: Partial<PresenceThresholds>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  writeRecord?: (record: PresenceRecord, options: { directory?: string }) => Promise<unknown>;
  onDiagnostic?: (diagnostic: PresenceDiagnostic) => void;
}

export interface PresenceRuntimeController {
  runtime: PresenceRuntimeIdentity;
  directory?: string;
  startup: PresenceRuntimeStartup;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

interface PresenceRuntimeState {
  cachedRuntimeIdentity: PresenceRuntimeIdentity | null;
  activeStartPromise: Promise<PresenceRuntimeController> | null;
  activeTimer: ReturnType<typeof setInterval> | null;
  activeDirectory: string | undefined;
  activeClearInterval: typeof globalThis.clearInterval;
}

type PresenceRuntimeGlobalState = typeof globalThis & {
  [PRESENCE_RUNTIME_STATE_KEY]?: PresenceRuntimeState;
};

function getPresenceRuntimeState(): PresenceRuntimeState {
  const globalState = globalThis as PresenceRuntimeGlobalState;
  const existingState = globalState[PRESENCE_RUNTIME_STATE_KEY];
  if (existingState !== undefined) {
    return existingState;
  }

  const createdState: PresenceRuntimeState = {
    cachedRuntimeIdentity: null,
    activeStartPromise: null,
    activeTimer: null,
    activeDirectory: undefined,
    activeClearInterval: globalThis.clearInterval,
  };
  globalState[PRESENCE_RUNTIME_STATE_KEY] = createdState;
  return createdState;
}

export function getPresenceRuntimeIdentity(
  options: {
    now?: () => Date;
    pid?: number;
    randomUUID?: () => string;
  } = {},
): PresenceRuntimeIdentity {
  const state = getPresenceRuntimeState();
  if (state.cachedRuntimeIdentity !== null) {
    return state.cachedRuntimeIdentity;
  }

  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;

  state.cachedRuntimeIdentity = {
    runtimeId: randomUUID(),
    pid,
    startedAt: now().toISOString(),
  };

  return state.cachedRuntimeIdentity;
}

export async function ensurePresenceRuntimeStarted(
  options: PresenceRuntimeStartOptions = {},
): Promise<PresenceRuntimeController> {
  const state = getPresenceRuntimeState();
  if (state.activeStartPromise !== null) {
    return state.activeStartPromise;
  }

  const runtime = getPresenceRuntimeIdentity(options);
  const directory = options.directory;
  const now = options.now ?? (() => new Date());
  const thresholds = resolvePresenceThresholds(options.thresholds);
  const setIntervalImpl = options.setInterval ?? globalThis.setInterval;
  state.activeClearInterval = options.clearInterval ?? globalThis.clearInterval;
  state.activeDirectory = directory;

  const writeRecord = options.writeRecord ?? writePresenceRecord;

  const writeHeartbeat = async (
    heartbeatAt: string,
  ): Promise<{ ok: true } | { ok: false; diagnostic: PresenceDiagnostic }> => {
    const record: PresenceRecord = {
      runtimeId: runtime.runtimeId,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      heartbeatAt,
    };

    try {
      await writeRecord(record, {
        ...(directory === undefined ? {} : { directory }),
      });
      return { ok: true };
    } catch (error) {
      const diagnostic = createWriteErrorDiagnostic(error, directory);
      try {
        options.onDiagnostic?.(diagnostic);
      } catch {
        // Keep write failures fail-open even when a diagnostic sink misbehaves.
      }
      return {
        ok: false,
        diagnostic,
      };
    }
  };

  state.activeStartPromise = (async () => {
    const startupWrite = await writeHeartbeat(runtime.startedAt);
    const startup: PresenceRuntimeStartup =
      startupWrite.ok === true
        ? { state: 'healthy' }
        : { state: 'degraded', diagnostic: startupWrite.diagnostic };

    if (state.activeTimer === null) {
      state.activeTimer = setIntervalImpl(() => {
        void writeHeartbeat(now().toISOString());
      }, thresholds.heartbeatIntervalMs);
      state.activeTimer.unref?.();
    }

    return {
      runtime,
      ...(directory === undefined ? {} : { directory }),
      startup,
      stop: async () => {
        await stopPresenceRuntime();
      },
      isRunning: () => getPresenceRuntimeState().activeTimer !== null,
    };
  })();

  return state.activeStartPromise;
}

export async function stopPresenceRuntime(): Promise<void> {
  const state = getPresenceRuntimeState();
  if (state.activeTimer !== null) {
    state.activeClearInterval(state.activeTimer);
    state.activeTimer = null;
  }

  state.activeStartPromise = null;
  state.activeDirectory = undefined;
  state.activeClearInterval = globalThis.clearInterval;
}

export async function resetPresenceRuntimeForTests(): Promise<void> {
  const state = getPresenceRuntimeState();
  await stopPresenceRuntime();
  state.cachedRuntimeIdentity = null;
}

function createWriteErrorDiagnostic(
  error: unknown,
  directory: string | undefined,
): PresenceDiagnostic {
  return {
    code: 'write_error',
    message: `Failed to write presence record: ${getErrorMessage(error)}`,
    ...(directory === undefined ? {} : { filePath: directory }),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
