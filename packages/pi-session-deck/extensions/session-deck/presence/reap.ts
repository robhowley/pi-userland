import type { Dirent } from 'node:fs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePresenceThresholds } from './constants.js';
import { getDefaultPresenceDirectory, isPresenceRecordFile } from './store.js';
import type { PresenceDiagnostic, PresenceRecord, PresenceThresholds } from './types.js';

export type PresenceDirectoryReader = (
  path: string,
  options: { withFileTypes: true },
) => Promise<Dirent<string>[]>;

export type PresenceFileReader = (path: string, encoding: 'utf8') => Promise<string>;

export interface ReapPresenceRecordsOptions {
  directory?: string;
  now?: Date;
  thresholds?: Partial<PresenceThresholds>;
  readdir?: PresenceDirectoryReader;
  readFile?: PresenceFileReader;
  unlink?: typeof unlink;
}

export interface ReapPresenceRecordsResult {
  removed: string[];
  diagnostics: PresenceDiagnostic[];
}

export async function reapPresenceRecords(
  options: ReapPresenceRecordsOptions = {},
): Promise<ReapPresenceRecordsResult> {
  const directory = options.directory ?? getDefaultPresenceDirectory();
  const thresholds = resolvePresenceThresholds(options.thresholds);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const readdirImpl = (options.readdir ?? readdir) as PresenceDirectoryReader;
  const readFileImpl = (options.readFile ?? readFile) as PresenceFileReader;
  const unlinkImpl = options.unlink ?? unlink;
  const removed: string[] = [];
  const diagnostics: PresenceDiagnostic[] = [];

  let entries: Dirent<string>[];
  try {
    entries = await readdirImpl(directory, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      return { removed, diagnostics };
    }

    diagnostics.push(
      createDiagnostic(
        'read_error',
        `Failed to read presence directory: ${getErrorMessage(error)}`,
        {
          filePath: directory,
        },
      ),
    );
    return { removed, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isPresenceRecordFile(entry.name)) {
      continue;
    }

    const filePath = join(directory, entry.name);

    let source: string;
    try {
      source = await readFileImpl(filePath, 'utf8');
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        diagnostics.push(
          createDiagnostic(
            'read_error',
            `Failed to read presence record: ${getErrorMessage(error)}`,
            {
              filePath,
            },
          ),
        );
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      diagnostics.push(
        createDiagnostic('malformed_record', `Ignored malformed JSON: ${getErrorMessage(error)}`, {
          filePath,
        }),
      );
      continue;
    }

    const record = normalizePresenceRecord(parsed);
    if (record === null) {
      diagnostics.push(
        createDiagnostic(
          'malformed_record',
          'Ignored malformed record: expected runtimeId, pid, startedAt, and heartbeatAt',
          {
            filePath,
          },
        ),
      );
      continue;
    }

    const heartbeatAtMs = Date.parse(record.heartbeatAt);
    if (!Number.isFinite(heartbeatAtMs)) {
      continue;
    }

    if (nowMs - heartbeatAtMs <= thresholds.reapAfterMs) {
      continue;
    }

    try {
      await unlinkImpl(filePath);
      removed.push(filePath);
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        diagnostics.push(
          createDiagnostic(
            'write_error',
            `Failed to reap presence record: ${getErrorMessage(error)}`,
            {
              filePath,
            },
          ),
        );
      }
    }
  }

  return { removed, diagnostics };
}

function normalizePresenceRecord(candidate: unknown): PresenceRecord | null {
  if (!isObject(candidate)) {
    return null;
  }

  const runtimeId = candidate['runtimeId'];
  const pid = candidate['pid'];
  const startedAt = candidate['startedAt'];
  const heartbeatAt = candidate['heartbeatAt'];

  if (typeof runtimeId !== 'string' || runtimeId.length === 0) {
    return null;
  }

  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (typeof startedAt !== 'string' || typeof heartbeatAt !== 'string') {
    return null;
  }

  return {
    runtimeId,
    pid,
    startedAt,
    heartbeatAt,
  };
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function createDiagnostic(
  code: PresenceDiagnostic['code'],
  message: string,
  options: { filePath?: string } = {},
): PresenceDiagnostic {
  return {
    code,
    message,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
