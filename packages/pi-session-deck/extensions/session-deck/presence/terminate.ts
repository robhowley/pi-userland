import { readFile } from 'node:fs/promises';
import { normalizePresenceRecord } from './reader.js';
import {
  getDefaultPresenceDirectory,
  getPresenceRecordPath,
  isSafePresenceRuntimeIdSegment,
} from './store.js';
import { inspectPresencePid } from './pid.js';
import type { InspectPresencePid, PresenceRecord } from './types.js';

export type TerminateSessionDeckRuntimeSuccessStatus = 'signal-sent' | 'already-exited';

export type TerminateSessionDeckRuntimeFailureReason =
  | 'invalid-runtime-id'
  | 'presence-missing'
  | 'presence-malformed'
  | 'runtime-mismatch'
  | 'pid-reused'
  | 'pid-unverified'
  | 'self-signal-denied'
  | 'permission-denied'
  | 'signal-failed';

export type TerminateSessionDeckRuntimeResult =
  | { ok: true; status: TerminateSessionDeckRuntimeSuccessStatus }
  | { ok: false; reason: TerminateSessionDeckRuntimeFailureReason };

export type TerminateSessionDeckRuntimeSignal = (pid: number, signal: NodeJS.Signals) => void;

export interface TerminateSessionDeckRuntimeOptions {
  directory?: string;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  inspectPid?: InspectPresencePid;
  inspectTimeoutMs?: number;
  signalProcess?: TerminateSessionDeckRuntimeSignal;
  currentPid?: number;
}

const DEFAULT_INSPECT_TIMEOUT_MS = 2_000;

export async function terminateSessionDeckRuntime(
  runtimeId: string,
  options: TerminateSessionDeckRuntimeOptions = {},
): Promise<TerminateSessionDeckRuntimeResult> {
  if (!isSafePresenceRuntimeIdSegment(runtimeId)) {
    return { ok: false, reason: 'invalid-runtime-id' };
  }

  const directory = options.directory ?? getDefaultPresenceDirectory();
  const filePath = getPresenceRecordPath(runtimeId, directory);
  const readFileImpl = options.readFile ?? readFile;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileImpl(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ok: false, reason: 'presence-missing' };
    }
    return { ok: false, reason: 'presence-malformed' };
  }

  const record = normalizePresenceRecord(parsed);
  if (record === null) {
    return normalizeMalformedPresence(runtimeId, parsed);
  }

  if (record.runtimeId !== runtimeId) {
    return { ok: false, reason: 'runtime-mismatch' };
  }

  if (record.pid === (options.currentPid ?? process.pid)) {
    return { ok: false, reason: 'self-signal-denied' };
  }

  let pidValidation: Awaited<ReturnType<InspectPresencePid>>;
  try {
    pidValidation = await inspectPidWithTimeout(
      record,
      options.inspectPid ?? inspectPresencePid,
      options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, reason: 'pid-unverified' };
  }

  switch (pidValidation.status) {
    case 'matches':
      return signalRecordPid(record, options.signalProcess ?? process.kill.bind(process));
    case 'missing':
      return { ok: true, status: 'already-exited' };
    case 'reused':
      return { ok: false, reason: 'pid-reused' };
    case 'unverified':
      return { ok: false, reason: 'pid-unverified' };
  }
}

function normalizeMalformedPresence(
  runtimeId: string,
  parsed: unknown,
): TerminateSessionDeckRuntimeResult {
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'presence-malformed' };
  }

  const parsedRuntimeId = parsed['runtimeId'];
  if (typeof parsedRuntimeId === 'string' && parsedRuntimeId !== runtimeId) {
    return { ok: false, reason: 'runtime-mismatch' };
  }

  if (
    parsedRuntimeId === runtimeId &&
    (!Object.prototype.hasOwnProperty.call(parsed, 'pid') || parsed['pid'] === null)
  ) {
    return { ok: true, status: 'already-exited' };
  }

  return { ok: false, reason: 'presence-malformed' };
}

async function inspectPidWithTimeout(
  record: PresenceRecord,
  inspectPid: InspectPresencePid,
  timeoutMs: number,
): ReturnType<InspectPresencePid> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { status: 'unverified', reason: 'pid_unverified' };
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      inspectPid(record),
      new Promise<Awaited<ReturnType<InspectPresencePid>>>((resolve) => {
        timeout = setTimeout(() => {
          resolve({ status: 'unverified', reason: 'pid_unverified' });
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function signalRecordPid(
  record: PresenceRecord,
  signalProcess: TerminateSessionDeckRuntimeSignal,
): TerminateSessionDeckRuntimeResult {
  try {
    signalProcess(record.pid, 'SIGTERM');
    return { ok: true, status: 'signal-sent' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return { ok: true, status: 'already-exited' };
    }
    if (code === 'EPERM') {
      return { ok: false, reason: 'permission-denied' };
    }
    return { ok: false, reason: 'signal-failed' };
  }
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
