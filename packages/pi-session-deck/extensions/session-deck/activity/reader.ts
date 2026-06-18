import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveActivity } from './derive.js';
import { getActivityRuntimeDiagnostics } from './runtime.js';
import { getDefaultActivityDirectory, isActivityRecordFile } from './store.js';
import type {
  ActivityDiagnostic,
  ActivityThresholds,
  SessionActivityRecord,
  SessionDeckDiagnostic,
  SessionDeckRecord,
  SessionDeckView,
} from './types.js';
import type { JoinedSessionView } from '../identity/types.js';

export type ActivityDirectoryReader = (
  path: string,
  options: { withFileTypes: true },
) => Promise<Dirent<string>[]>;

export type ActivityFileReader = (path: string, encoding: 'utf8') => Promise<string>;

export interface ReadSessionDeckViewOptions {
  joinedView: JoinedSessionView;
  activityDirectory?: string;
  now?: Date;
  thresholds?: Partial<ActivityThresholds>;
  readdir?: ActivityDirectoryReader;
  readFile?: ActivityFileReader;
  runtimeDiagnostics?: ActivityDiagnostic[];
}

interface ScannedActivityRecords {
  records: Map<string, SessionActivityRecord>;
  diagnosticsByRuntimeId: Map<string, ActivityDiagnostic[]>;
  diagnostics: ActivityDiagnostic[];
}

export async function readSessionDeckView(
  options: ReadSessionDeckViewOptions,
): Promise<SessionDeckView> {
  const directory = options.activityDirectory ?? getDefaultActivityDirectory();
  const readdirImpl = (options.readdir ?? readdir) as ActivityDirectoryReader;
  const readFileImpl = (options.readFile ?? readFile) as ActivityFileReader;
  const scan = await scanActivityRecords(directory, readdirImpl, readFileImpl);
  const runtimeDiagnostics = groupDiagnosticsByRuntime(
    options.runtimeDiagnostics ?? getActivityRuntimeDiagnostics(),
  );

  const diagnostics: SessionDeckDiagnostic[] =
    options.joinedView.diagnostics.map(toSessionDeckDiagnostic);
  diagnostics.push(...scan.diagnostics.map(toSessionDeckDiagnostic));

  const matchedRuntimeIds = new Set<string>();
  const records: SessionDeckRecord[] = [];

  for (const joinedRecord of options.joinedView.records) {
    matchedRuntimeIds.add(joinedRecord.runtimeId);

    const activityDiagnostics = [
      ...(scan.diagnosticsByRuntimeId.get(joinedRecord.runtimeId) ?? []),
      ...(runtimeDiagnostics.get(joinedRecord.runtimeId) ?? []),
    ];
    const derived = deriveActivity({
      activity: scan.records.get(joinedRecord.runtimeId) ?? null,
      sessionId: joinedRecord.sessionId,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
      baseDiagnostics: activityDiagnostics,
    });

    const recordDiagnostics = [
      ...joinedRecord.diagnostics.map(toSessionDeckDiagnostic),
      ...derived.diagnostics.map(toSessionDeckDiagnostic),
    ];

    records.push({
      ...joinedRecord,
      activityState: derived.activityState,
      activityAgeMs: derived.activityAgeMs,
      idle: derived.idle,
      busy: derived.busy,
      currentTurnStartedAt: derived.currentTurnStartedAt,
      currentToolName: derived.currentToolName,
      lastEventAt: derived.lastEventAt,
      lastError: derived.lastError,
      activityUpdatedAt: derived.activityUpdatedAt,
      diagnostics: recordDiagnostics,
    });

    diagnostics.push(...derived.diagnostics.map(toSessionDeckDiagnostic));
  }

  for (const [runtimeId, activityDiagnostics] of scan.diagnosticsByRuntimeId) {
    if (matchedRuntimeIds.has(runtimeId)) {
      continue;
    }
    diagnostics.push(...activityDiagnostics.map(toSessionDeckDiagnostic));
  }

  for (const [runtimeId, activityDiagnostics] of runtimeDiagnostics) {
    if (matchedRuntimeIds.has(runtimeId)) {
      continue;
    }
    diagnostics.push(...activityDiagnostics.map(toSessionDeckDiagnostic));
  }

  return { records, diagnostics };
}

async function scanActivityRecords(
  directory: string,
  readdirImpl: ActivityDirectoryReader,
  readFileImpl: ActivityFileReader,
): Promise<ScannedActivityRecords> {
  const records = new Map<string, SessionActivityRecord>();
  const diagnosticsByRuntimeId = new Map<string, ActivityDiagnostic[]>();
  const diagnostics: ActivityDiagnostic[] = [];

  let entries: Dirent<string>[];
  try {
    entries = await readdirImpl(directory, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      diagnostics.push({
        code: 'activity_read_error',
        message: `Failed to read activity directory: ${getErrorMessage(error)}`,
        filePath: directory,
      });
    }
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isActivityRecordFile(entry.name)) {
      continue;
    }

    const filePath = join(directory, entry.name);
    const runtimeId = entry.name.replace(/\.json$/, '');

    let source: string;
    try {
      source = await readFileImpl(filePath, 'utf8');
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
          code: 'activity_read_error',
          message: `Failed to read activity record: ${getErrorMessage(error)}`,
          runtimeId,
          filePath,
        });
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
        code: 'malformed_activity_record',
        message: `Ignored malformed JSON: ${getErrorMessage(error)}`,
        runtimeId,
        filePath,
      });
      continue;
    }

    const record = normalizeActivityRecord(parsed);
    if (record === null || record.runtimeId !== runtimeId) {
      pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
        code: 'malformed_activity_record',
        message: 'Ignored malformed activity record',
        runtimeId,
        filePath,
      });
      continue;
    }

    records.set(runtimeId, record);
  }

  return { records, diagnosticsByRuntimeId, diagnostics };
}

function normalizeActivityRecord(candidate: unknown): SessionActivityRecord | null {
  if (!isObject(candidate)) {
    return null;
  }

  const runtimeId = candidate['runtimeId'];
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) {
    return null;
  }

  const lastUserTurnAt = normalizeStringField(candidate['lastUserTurnAt']);
  const lastAssistantTurnAt = normalizeStringField(candidate['lastAssistantTurnAt']);
  const lastToolStartedAt = normalizeStringField(candidate['lastToolStartedAt']);
  const lastToolEndedAt = normalizeStringField(candidate['lastToolEndedAt']);
  const lastErrorAt = normalizeStringField(candidate['lastErrorAt']);
  const activityUpdatedAt = normalizeStringField(candidate['activityUpdatedAt']);
  const activitySource = normalizeActivitySource(candidate['activitySource']);

  return {
    runtimeId,
    sessionId: normalizeStringField(candidate['sessionId']),
    activityState: normalizeActivityState(candidate['activityState']),
    idle: normalizeBooleanField(candidate['idle']),
    busy: normalizeBooleanField(candidate['busy']),
    currentTurnStartedAt: normalizeStringField(candidate['currentTurnStartedAt']),
    currentToolName: normalizeStringField(candidate['currentToolName']),
    lastEventAt: normalizeStringField(candidate['lastEventAt']),
    lastError: normalizeStringField(candidate['lastError']),
    ...(lastUserTurnAt === null ? {} : { lastUserTurnAt }),
    ...(lastAssistantTurnAt === null ? {} : { lastAssistantTurnAt }),
    ...(lastToolStartedAt === null ? {} : { lastToolStartedAt }),
    ...(lastToolEndedAt === null ? {} : { lastToolEndedAt }),
    ...(lastErrorAt === null ? {} : { lastErrorAt }),
    ...(activityUpdatedAt === null ? {} : { activityUpdatedAt }),
    ...(activitySource === undefined ? {} : { activitySource }),
  };
}

function normalizeActivityState(value: unknown): SessionActivityRecord['activityState'] {
  switch (value) {
    case 'waiting':
    case 'thinking':
    case 'tool-running':
    case 'error':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeActivitySource(
  value: unknown,
): SessionActivityRecord['activitySource'] | undefined {
  switch (value) {
    case 'startup':
    case 'new':
    case 'message_end':
    case 'turn_start':
    case 'tool_start':
    case 'tool_end':
    case 'turn_end':
    case 'assistant_error':
    case 'periodic':
      return value;
    default:
      return undefined;
  }
}

function normalizeBooleanField(value: unknown): boolean {
  return value === true;
}

function normalizeStringField(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return null;
}

function groupDiagnosticsByRuntime(
  diagnostics: ActivityDiagnostic[],
): Map<string, ActivityDiagnostic[]> {
  const grouped = new Map<string, ActivityDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.runtimeId === undefined) {
      continue;
    }
    pushRuntimeDiagnostic(grouped, diagnostic.runtimeId, diagnostic);
  }
  return grouped;
}

function pushRuntimeDiagnostic(
  diagnosticsByRuntimeId: Map<string, ActivityDiagnostic[]>,
  runtimeId: string,
  diagnostic: ActivityDiagnostic,
): void {
  const existing = diagnosticsByRuntimeId.get(runtimeId) ?? [];
  existing.push(diagnostic);
  diagnosticsByRuntimeId.set(runtimeId, existing);
}

function toSessionDeckDiagnostic(diagnostic: {
  code: string;
  message: string;
  runtimeId?: string;
  filePath?: string;
}): SessionDeckDiagnostic {
  return {
    code: diagnostic.code as SessionDeckDiagnostic['code'],
    message: diagnostic.message,
    ...(diagnostic.runtimeId === undefined ? {} : { runtimeId: diagnostic.runtimeId }),
    ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
  };
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
