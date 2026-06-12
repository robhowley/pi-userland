import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { resolvePresenceThresholds } from './constants.js';
import { writePresenceRecord } from './writer.js';
import type { PresenceDiagnostic, PresenceRecord, PresenceThresholds } from './types.js';

export interface PresenceRuntimeIdentity {
  runtimeId: string;
  pid: number;
  startedAt: string;
}

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
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

let cachedRuntimeIdentity: PresenceRuntimeIdentity | null = null;
let activeStartPromise: Promise<PresenceRuntimeController> | null = null;
let activeTimer: ReturnType<typeof setInterval> | null = null;
let activeDirectory: string | undefined;
let activeClearInterval: typeof globalThis.clearInterval = globalThis.clearInterval;

export function getPresenceRuntimeIdentity(
  options: {
    now?: () => Date;
    pid?: number;
    randomUUID?: () => string;
  } = {},
): PresenceRuntimeIdentity {
  if (cachedRuntimeIdentity !== null) {
    return cachedRuntimeIdentity;
  }

  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const randomUUID = options.randomUUID ?? nodeRandomUUID;

  cachedRuntimeIdentity = {
    runtimeId: randomUUID(),
    pid,
    startedAt: now().toISOString(),
  };

  return cachedRuntimeIdentity;
}

export async function ensurePresenceRuntimeStarted(
  options: PresenceRuntimeStartOptions = {},
): Promise<PresenceRuntimeController> {
  if (activeStartPromise !== null) {
    return activeStartPromise;
  }

  const runtime = getPresenceRuntimeIdentity(options);
  const now = options.now ?? (() => new Date());
  const thresholds = resolvePresenceThresholds(options.thresholds);
  const setIntervalImpl = options.setInterval ?? globalThis.setInterval;
  activeClearInterval = options.clearInterval ?? globalThis.clearInterval;
  activeDirectory = options.directory;

  const writeRecord = options.writeRecord ?? writePresenceRecord;

  const writeHeartbeat = async (heartbeatAt: string): Promise<void> => {
    const record: PresenceRecord = {
      runtimeId: runtime.runtimeId,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      heartbeatAt,
    };

    try {
      await writeRecord(record, {
        ...(options.directory === undefined ? {} : { directory: options.directory }),
      });
    } catch (error) {
      options.onDiagnostic?.({
        code: 'write_error',
        message: `Failed to write presence record: ${getErrorMessage(error)}`,
        ...(options.directory === undefined ? {} : { filePath: options.directory }),
      });
    }
  };

  activeStartPromise = (async () => {
    await writeHeartbeat(runtime.startedAt);

    if (activeTimer === null) {
      activeTimer = setIntervalImpl(() => {
        void writeHeartbeat(now().toISOString());
      }, thresholds.heartbeatIntervalMs);
      activeTimer.unref?.();
    }

    return {
      runtime,
      ...(activeDirectory === undefined ? {} : { directory: activeDirectory }),
      stop: async () => {
        await stopPresenceRuntime();
      },
      isRunning: () => activeTimer !== null,
    };
  })();

  return activeStartPromise;
}

export async function stopPresenceRuntime(): Promise<void> {
  if (activeTimer !== null) {
    activeClearInterval(activeTimer);
    activeTimer = null;
  }

  activeStartPromise = null;
  activeDirectory = undefined;
}

export async function resetPresenceRuntimeForTests(): Promise<void> {
  await stopPresenceRuntime();
  cachedRuntimeIdentity = null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
