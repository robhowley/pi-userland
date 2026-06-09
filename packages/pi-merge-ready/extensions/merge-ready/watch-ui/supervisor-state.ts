import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { MergeReadyWatchStatusRecord } from '../watch-status.js';

export const MERGE_READY_WATCH_UI_SERVICE = 'merge-ready-watch-ui';
export const MERGE_READY_WATCH_UI_STATE_VERSION = 1 as const;

export type MergeReadyWatchUiPaths = {
  stateDir: string;
  supervisorInfoFile: string;
  tokenFile: string;
  watchesFile: string;
  logFile: string;
  startupLockDir: string;
};

export type MergeReadyWatchSupervisorInfo = {
  service: typeof MERGE_READY_WATCH_UI_SERVICE;
  pid: number;
  port: number;
  startedAt: string;
  packageVersion: string;
  tokenFile: string;
  defaultCwd: string;
  extensionDir: string;
  extensionEntryPath: string;
};

export type MergeReadyWatchRecordState = 'active' | 'stopped' | 'stale' | 'error';

export type MergeReadyPersistedWatchRecord = {
  id: string;
  canonicalUrl: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  state: MergeReadyWatchRecordState;
  session: {
    sessionId?: string;
    sessionFile?: string;
  };
  lastStatus?: MergeReadyWatchStatusRecord;
  lastError?: string;
};

export type MergeReadyPersistedWatchesState = {
  version: typeof MERGE_READY_WATCH_UI_STATE_VERSION;
  watches: MergeReadyPersistedWatchRecord[];
};

export function getMergeReadyWatchUiPaths(agentDir = getAgentDir()): MergeReadyWatchUiPaths {
  const stateDir = path.join(agentDir, 'merge-ready', 'watch-ui');
  return {
    stateDir,
    supervisorInfoFile: path.join(stateDir, 'supervisor.json'),
    tokenFile: path.join(stateDir, 'token'),
    watchesFile: path.join(stateDir, 'watches.json'),
    logFile: path.join(stateDir, 'supervisor.log'),
    startupLockDir: path.join(stateDir, 'startup.lock'),
  };
}

export function createEmptyPersistedWatchesState(): MergeReadyPersistedWatchesState {
  return {
    version: MERGE_READY_WATCH_UI_STATE_VERSION,
    watches: [],
  };
}

export async function ensureMergeReadyWatchUiStateDir(
  paths: MergeReadyWatchUiPaths,
): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
}

export async function readMergeReadyWatchSupervisorInfo(
  paths: MergeReadyWatchUiPaths,
): Promise<MergeReadyWatchSupervisorInfo | null> {
  return readJsonFile<MergeReadyWatchSupervisorInfo>(paths.supervisorInfoFile);
}

export async function writeMergeReadyWatchSupervisorInfo(
  paths: MergeReadyWatchUiPaths,
  info: MergeReadyWatchSupervisorInfo,
): Promise<void> {
  await ensureMergeReadyWatchUiStateDir(paths);
  await writeJsonAtomically(paths.supervisorInfoFile, info);
}

export async function removeMergeReadyWatchSupervisorInfo(
  paths: MergeReadyWatchUiPaths,
): Promise<void> {
  await rm(paths.supervisorInfoFile, { force: true });
}

export async function ensureMergeReadyWatchUiToken(paths: MergeReadyWatchUiPaths): Promise<string> {
  const existing = await readMergeReadyWatchUiToken(paths);
  if (existing) {
    return existing;
  }

  const token = randomBytes(24).toString('hex');
  await ensureMergeReadyWatchUiStateDir(paths);
  await writeFile(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

export async function readMergeReadyWatchUiToken(
  paths: MergeReadyWatchUiPaths,
): Promise<string | null> {
  try {
    const token = await readFile(paths.tokenFile, 'utf8');
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export async function readMergeReadyPersistedWatchesState(
  paths: MergeReadyWatchUiPaths,
): Promise<MergeReadyPersistedWatchesState> {
  return (
    (await readJsonFile<MergeReadyPersistedWatchesState>(paths.watchesFile)) ??
    createEmptyPersistedWatchesState()
  );
}

export async function writeMergeReadyPersistedWatchesState(
  paths: MergeReadyWatchUiPaths,
  state: MergeReadyPersistedWatchesState,
): Promise<void> {
  await ensureMergeReadyWatchUiStateDir(paths);
  await writeJsonAtomically(paths.watchesFile, state);
}

export function reconcilePersistedWatchesState(
  state: MergeReadyPersistedWatchesState,
): MergeReadyPersistedWatchesState {
  return {
    version: MERGE_READY_WATCH_UI_STATE_VERSION,
    watches: state.watches.map((watch) => reconcilePersistedWatchRecord(watch)),
  };
}

export function reconcilePersistedWatchRecord(
  watch: MergeReadyPersistedWatchRecord,
): MergeReadyPersistedWatchRecord {
  if (watch.state === 'stopped' || watch.state === 'stale' || watch.state === 'error') {
    return watch;
  }

  if (!watch.session.sessionFile) {
    return {
      ...watch,
      state: 'error',
      updatedAt: new Date().toISOString(),
      lastError: 'Missing persisted session file for prior watch session.',
    };
  }

  return {
    ...watch,
    state: 'stale',
    updatedAt: new Date().toISOString(),
  };
}

export async function acquireMergeReadyWatchUiStartupLock(
  paths: MergeReadyWatchUiPaths,
  options: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  await ensureMergeReadyWatchUiStateDir(paths);

  while (true) {
    try {
      await mkdir(paths.startupLockDir);
      return async () => {
        await rm(paths.startupLockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for merge-ready watch UI startup lock.');
      }

      await delay(retryDelayMs);
    }
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempFile, filePath);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}

function isMissingFileError(error: unknown): boolean {
  return isNodeErrorWithCode(error, 'ENOENT');
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeErrorWithCode(error, 'EEXIST');
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
