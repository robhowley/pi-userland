import { DEFAULT_IDENTITY_REFRESH_INTERVAL_MS } from './constants.js';
import { collectSessionIdentity } from './collector.js';
import { writeIdentityRecord } from './writer.js';
import type { GitExec, IdentityDiagnostic, SessionIdentityRecord } from './types.js';

const IDENTITY_RUNTIME_STATE_KEY = '__piSessionDeckIdentityRuntimeState__';

export interface IdentityRuntimeConfig {
  runtimeId?: string;
  directory?: string;
  now?: () => Date;
  cwd?: string;
  execGit?: GitExec;
  writeRecord?: (
    record: SessionIdentityRecord,
    options: { directory?: string },
  ) => Promise<unknown>;
  onDiagnostic?: (diagnostic: IdentityDiagnostic) => void;
}

export interface SessionManagerLike {
  getSessionId: () => string | null;
  getSessionFile: () => string | null;
}

export interface IdentityRuntimeController {
  refreshIdentity: (source: string, sessionManager?: SessionManagerLike) => Promise<void>;
  getIdentity: () => SessionIdentityRecord | null;
  isRunning: () => boolean;
}

interface IdentityRuntimeState {
  cachedIdentity: SessionIdentityRecord | null;
  activeStartPromise: Promise<IdentityRuntimeController> | null;
  activeTimer: ReturnType<typeof setInterval> | null;
  activeDirectory: string | undefined;
  activeClearInterval: typeof globalThis.clearInterval;
  runtimeId: string | undefined;
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

  state.activeStartPromise = (async () => {
    const controller: IdentityRuntimeController = {
      refreshIdentity: async (
        source: string,
        sessionManager?: {
          getSessionId: () => string | null;
          getSessionFile: () => string | null;
        },
      ) => {
        const rid = state.runtimeId;
        if (rid === undefined) {
          return;
        }

        const writeRecord = config.writeRecord ?? writeIdentityRecord;
        const directory = state.activeDirectory;

        try {
          const record = await collectSessionIdentity(rid, {
            runtimeId: rid,
            ...(sessionManager === undefined ? {} : { sessionManager }),
            ...(config.now === undefined ? {} : { now: config.now }),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            ...(config.execGit === undefined ? {} : { execGit: config.execGit }),
            identitySource: source,
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
      },
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
}

export async function resetIdentityRuntimeForTests(): Promise<void> {
  const state = getIdentityRuntimeState();
  await stopIdentityRuntime();
  state.cachedIdentity = null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
