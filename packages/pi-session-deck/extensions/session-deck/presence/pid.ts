import { execFile as nodeExecFile } from 'node:child_process';
import { resolvePresenceThresholds } from './constants.js';
import type { PresenceRecord, PresenceThresholds, PidValidationResult } from './types.js';

export interface PidExistenceResult {
  exists: boolean;
}

export type PidExistenceProbe = (pid: number) => PidExistenceResult;
export type PidStartTimeReader = (pid: number) => Promise<string | null>;
export type ExecFileLike = (
  file: string,
  args: string[],
  options?: { windowsHide?: boolean },
) => Promise<{ stdout: string }>;

const defaultExecFile: ExecFileLike = async (file, args, options) =>
  await new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout });
    });
  });

export function checkPidExists(
  pid: number,
  killImpl: (pidToCheck: number, signal: number) => boolean = process.kill.bind(process),
): PidExistenceResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { exists: false };
  }

  try {
    killImpl(pid, 0);
    return { exists: true };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ESRCH') {
      return { exists: false };
    }

    if (errorCode === 'EPERM') {
      return { exists: true };
    }

    return { exists: true };
  }
}

export async function readPidStartedAt(
  pid: number,
  execFileImpl: ExecFileLike = defaultExecFile,
): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl('ps', ['-o', 'lstart=', '-p', String(pid)], {
      windowsHide: true,
    });
    const line = stdout
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);

    if (!line) {
      return null;
    }

    const parsed = Date.parse(line);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return new Date(parsed).toISOString();
  } catch {
    return null;
  }
}

export interface InspectPresencePidOptions {
  thresholds?: Partial<PresenceThresholds>;
  probePidExists?: PidExistenceProbe;
  readPidStartedAt?: PidStartTimeReader;
}

export async function inspectPresencePid(
  record: PresenceRecord,
  options: InspectPresencePidOptions = {},
): Promise<PidValidationResult> {
  try {
    const probePidExists = options.probePidExists ?? checkPidExists;
    const pidStatus = probePidExists(record.pid);
    if (!pidStatus.exists) {
      return { status: 'missing', reason: 'pid_missing' };
    }

    const readStartTime = options.readPidStartedAt ?? readPidStartedAt;
    const observedStartedAt = await readStartTime(record.pid);
    if (observedStartedAt === null) {
      return { status: 'unverified', reason: 'pid_unverified' };
    }

    const storedStartedAtMs = Date.parse(record.startedAt);
    const observedStartedAtMs = Date.parse(observedStartedAt);
    if (!Number.isFinite(storedStartedAtMs) || !Number.isFinite(observedStartedAtMs)) {
      return { status: 'unverified', reason: 'pid_unverified' };
    }

    const { pidReuseGraceMs } = resolvePresenceThresholds(options.thresholds);
    if (observedStartedAtMs > storedStartedAtMs + pidReuseGraceMs) {
      return {
        status: 'reused',
        reason: 'pid_reused',
        observedStartedAt: new Date(observedStartedAtMs).toISOString(),
      };
    }

    return {
      status: 'matches',
      observedStartedAt: new Date(observedStartedAtMs).toISOString(),
    };
  } catch {
    return { status: 'unverified', reason: 'pid_unverified' };
  }
}
