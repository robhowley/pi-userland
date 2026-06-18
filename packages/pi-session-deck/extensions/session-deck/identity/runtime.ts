import { DEFAULT_IDENTITY_REFRESH_INTERVAL_MS } from './constants.js';
import { collectSessionIdentity } from './collector.js';
import { writeIdentityRecord } from './writer.js';
import type {
  GhExec,
  GitExec,
  IdentityDiagnostic,
  IdentityRuntimeController,
  SessionIdentityRecord,
  SessionManagerLike,
} from './types.js';

const IDENTITY_RUNTIME_STATE_KEY = '__piSessionDeckIdentityRuntimeState__';

export interface IdentityRuntimeConfig {
  runtimeId?: string;
  directory?: string;
  now?: () => Date;
  cwd?: string;
  execGit?: GitExec;
  execGhCli?: GhExec | null;
  writeRecord?: (
    record: SessionIdentityRecord,
    options: { directory?: string },
  ) => Promise<unknown>;
  onDiagnostic?: (diagnostic: IdentityDiagnostic) => void;
}

interface IdentityRuntimeState {
  cachedIdentity: SessionIdentityRecord | null;
  activeStartPromise: Promise<IdentityRuntimeController> | null;
  activeTimer: ReturnType<typeof setInterval> | null;
  activeDirectory: string | undefined;
  activeClearInterval: typeof globalThis.clearInterval;
  runtimeId: string | undefined;
  sessionManager: SessionManagerLike | null;
  pendingMutation: Promise<void>;
}

type IdentityRuntimeGlobalState = typeof globalThis & {
  [IDENTITY_RUNTIME_STATE_KEY]?: IdentityRuntimeState;
};

function getIdentityRuntimeState(): IdentityRuntimeState {
  const globalState = globalThis as IdentityRuntimeGlobalState;
  const existingState = globalState[IDENTITY_RUNTIME_STATE_KEY];
  if (existingState !== undefined) {
    return existingState;
  }

  const createdState: IdentityRuntimeState = {
    cachedIdentity: null,
    activeStartPromise: null,
    activeTimer: null,
    activeDirectory: undefined,
    activeClearInterval: globalThis.clearInterval,
    runtimeId: undefined,
    sessionManager: null,
    pendingMutation: Promise.resolve(),
  };
  globalState[IDENTITY_RUNTIME_STATE_KEY] = createdState;
  return createdState;
}

export async function ensureIdentityRuntimeStarted(
  runtimeId: string,
  config: IdentityRuntimeConfig = {},
): Promise<IdentityRuntimeController> {
  const state = getIdentityRuntimeState();
  if (state.activeStartPromise !== null) {
    return state.activeStartPromise;
  }

  state.runtimeId = runtimeId;
  state.activeDirectory = config.directory;
  state.sessionManager = null;

  state.activeStartPromise = (async () => {
    const controller: IdentityRuntimeController = {
      refreshIdentity: async (source: string, sessionManager?: SessionManagerLike) =>
        runSerialized(state, async () => {
          const rid = state.runtimeId;
          if (rid === undefined) {
            return;
          }

          if (sessionManager !== undefined) {
            state.sessionManager = sessionManager;
          }

          const writeRecord = config.writeRecord ?? writeIdentityRecord;
          const directory = state.activeDirectory;
          const sm = state.sessionManager ?? sessionManager;

          try {
            const record = await collectSessionIdentity(rid, {
              runtimeId: rid,
              ...(sm === null || sm === undefined ? {} : { sessionManager: sm }),
              ...(config.now === undefined ? {} : { now: config.now }),
              ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
              ...(config.execGit === undefined ? {} : { execGit: config.execGit }),
              ...(config.execGhCli === undefined ? {} : { execGhCli: config.execGhCli }),
              ...(state.cachedIdentity === null ? {} : { existingRecord: state.cachedIdentity }),
              identitySource: source,
              ...(config.onDiagnostic === undefined ? {} : { onDiagnostic: config.onDiagnostic }),
            });

            await writeRecord(record, {
              ...(directory === undefined ? {} : { directory }),
            });

            state.cachedIdentity = record;
          } catch (error) {
            const diagnostic: IdentityDiagnostic = {
              code: 'identity_write_error',
              message: `Failed to write identity record: ${getErrorMessage(error)}`,
              runtimeId: rid,
            };
            try {
              config.onDiagnostic?.(diagnostic);
            } catch {
              // Fail-open on diagnostic sink errors
            }
          }
        }),
      getIdentity: () => state.cachedIdentity,
      isRunning: () => state.activeTimer !== null,
    };

    // Start periodic refresh
    if (state.activeTimer === null) {
      state.activeTimer = setInterval(() => {
        void controller.refreshIdentity('periodic');
      }, DEFAULT_IDENTITY_REFRESH_INTERVAL_MS);
      state.activeTimer.unref?.();
    }

    return controller;
  })();

  return state.activeStartPromise;
}

export async function stopIdentityRuntime(): Promise<void> {
  const state = getIdentityRuntimeState();
  if (state.activeTimer !== null) {
    state.activeClearInterval(state.activeTimer);
    state.activeTimer = null;
  }

  state.activeStartPromise = null;
  state.activeDirectory = undefined;
  state.runtimeId = undefined;
  state.sessionManager = null;
  state.pendingMutation = Promise.resolve();
}

export async function resetIdentityRuntimeForTests(): Promise<void> {
  const state = getIdentityRuntimeState();
  await stopIdentityRuntime();
  state.cachedIdentity = null;
}

async function runSerialized<T>(
  state: IdentityRuntimeState,
  operation: () => Promise<T>,
): Promise<T> {
  state.pendingMutation ??= Promise.resolve();
  const run = state.pendingMutation.then(operation, operation);
  state.pendingMutation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
