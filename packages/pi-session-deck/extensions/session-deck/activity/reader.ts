import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveActivity } from './derive.js';
import { getActivityRuntimeDiagnostics } from './runtime.js';
import { getDefaultActivityDirectory, isActivityRecordFile } from './store.js';
import { attachChildRuntimeFacets } from '../parentage/derive.js';
import type {
  ActivityDiagnostic,
  ActivityInputSource,
  ActivityInputSummary,
  ActivityThresholds,
  ActivityToolWindow,
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
    const activity = scan.records.get(joinedRecord.runtimeId) ?? null;
    const activityForParentage = isActivityTrustedForParentage(activity, joinedRecord);
    const derived = deriveActivity({
      activity,
      sessionId: joinedRecord.sessionId,
      sessionIdentityVerified: joinedRecord.identityFreshness !== 'missing',
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
      ...(activityForParentage?.inputSummary === undefined
        ? {}
        : { inputSummary: activityForParentage.inputSummary }),
      ...(activityForParentage?.recentToolWindows === undefined
        ? {}
        : { recentToolWindows: activityForParentage.recentToolWindows }),
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

  return { records: attachChildRuntimeFacets(records), diagnostics };
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

function isActivityTrustedForParentage(
  activity: SessionActivityRecord | null,
  record: { sessionId: string | null; identityFreshness: string },
): SessionActivityRecord | null {
  if (activity === null || record.identityFreshness === 'missing') {
    return null;
  }

  return activity.sessionId === record.sessionId ? activity : null;
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
  const inputSummary = normalizeInputSummary(candidate['inputSummary']);
  const recentToolWindows = normalizeRecentToolWindows(candidate['recentToolWindows']);

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
    ...(inputSummary === undefined ? {} : { inputSummary }),
    ...(recentToolWindows === undefined ? {} : { recentToolWindows }),
    ...(activityUpdatedAt === null ? {} : { activityUpdatedAt }),
    ...(activitySource === undefined ? {} : { activitySource }),
  };
}

function normalizeActivityState(value: unknown): SessionActivityRecord['activityState'] {
  switch (value) {
    case 'idle':
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
    case 'input':
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

function normalizeInputSummary(value: unknown): ActivityInputSummary | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const lastSource = normalizeInputSource(value['lastSource']);
  const lastInputAt = normalizeOptionalStringField(value['lastInputAt']);
  const counts = normalizeInputCounts(value['counts']);
  if (lastSource === undefined && lastInputAt === undefined && counts === undefined) {
    return undefined;
  }

  return {
    ...(lastSource === undefined ? {} : { lastSource }),
    ...(lastInputAt === undefined ? {} : { lastInputAt }),
    ...(counts === undefined ? {} : { counts }),
  };
}

function normalizeInputCounts(value: unknown): ActivityInputSummary['counts'] | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const counts: Partial<Record<ActivityInputSource, number>> = {};
  for (const source of ['interactive', 'rpc', 'extension'] as const) {
    const count = value[source];
    if (count === undefined) {
      continue;
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      return undefined;
    }
    counts[source] = count;
  }

  return Object.keys(counts).length === 0 ? undefined : counts;
}

function normalizeInputSource(value: unknown): ActivityInputSource | undefined {
  switch (value) {
    case 'interactive':
    case 'rpc':
    case 'extension':
      return value;
    default:
      return undefined;
  }
}

function normalizeRecentToolWindows(value: unknown): ActivityToolWindow[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const windows = value
    .map((entry) => normalizeRecentToolWindow(entry))
    .filter((entry): entry is ActivityToolWindow => entry !== null)
    .slice(-20);
  return windows.length === 0 ? undefined : windows;
}

function normalizeRecentToolWindow(value: unknown): ActivityToolWindow | null {
  if (!isObject(value)) {
    return null;
  }

  const toolCallId = normalizeOptionalStringField(value['toolCallId']);
  const toolName = normalizeOptionalStringField(value['toolName']);
  const startedAt = normalizeOptionalStringField(value['startedAt']);
  if (toolCallId === undefined || toolName === undefined || startedAt === undefined) {
    return null;
  }

  const endedAt = normalizeOptionalStringField(value['endedAt']);
  return {
    toolCallId,
    toolName,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(value['isError'] === true ? { isError: true } : {}),
  };
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

function normalizeOptionalStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
