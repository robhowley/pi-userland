import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyPresenceRecord } from './classify.js';
import { getDefaultPresenceDirectory, isPresenceRecordFile } from './store.js';
import type {
  InspectPresencePid,
  PresenceDiagnostic,
  PresenceRecord,
  PresenceSummary,
  PresenceThresholds,
  PresenceView,
} from './types.js';

export type PresenceDirectoryReader = (
  path: string,
  options: { withFileTypes: true },
) => Promise<Dirent<string>[]>;

export type PresenceFileReader = (path: string, encoding: 'utf8') => Promise<string>;

export interface ReadPresenceViewOptions {
  directory?: string;
  now?: Date;
  thresholds?: Partial<PresenceThresholds>;
  inspectPid?: InspectPresencePid;
  readdir?: PresenceDirectoryReader;
  readFile?: PresenceFileReader;
}

export async function readPresenceView(
  options: ReadPresenceViewOptions = {},
): Promise<PresenceView> {
  const directory = options.directory ?? getDefaultPresenceDirectory();
  const diagnostics: PresenceDiagnostic[] = [];
  const records: PresenceSummary[] = [];
  const readdirImpl = (options.readdir ?? readdir) as PresenceDirectoryReader;
  const readFileImpl = (options.readFile ?? readFile) as PresenceFileReader;

  let entries: Dirent<string>[];
  try {
    entries = await readdirImpl(directory, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      return { records: [], diagnostics: [] };
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
    return { records, diagnostics };
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

    records.push(
      await classifyPresenceRecord(record, {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
        ...(options.inspectPid === undefined ? {} : { inspectPid: options.inspectPid }),
      }),
    );
  }

  records.sort((left, right) => sortByHeartbeatDesc(left.heartbeatAt, right.heartbeatAt));

  return { records, diagnostics };
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

function sortByHeartbeatDesc(leftHeartbeatAt: string, rightHeartbeatAt: string): number {
  return parseTimestamp(rightHeartbeatAt) - parseTimestamp(leftHeartbeatAt);
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
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
