import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_IDENTITY_FRESHNESS_THRESHOLDS,
  resolveIdentityFreshnessThresholds,
} from './constants.js';
import { getDefaultIdentityDirectory, isIdentityRecordFile } from './store.js';
import type {
  IdentityDiagnosticCode,
  IdentityFreshness,
  IdentityFreshnessThresholds,
  JoinedDiagnostic,
  JoinedSessionRecord,
  JoinedSessionView,
  SessionIdentityRecord,
} from './types.js';
import type { PresenceDiagnosticCode, PresenceSummary, PresenceView } from '../presence/types.js';

export type IdentityDirectoryReader = (
  path: string,
  options: { withFileTypes: true },
) => Promise<Dirent<string>[]>;

export type IdentityFileReader = (path: string, encoding: 'utf8') => Promise<string>;

export interface ReadJoinedSessionViewOptions {
  identityDirectory?: string;
  presenceView: PresenceView;
  now?: Date;
  identityFreshnessThresholds?: Partial<IdentityFreshnessThresholds>;
  readdir?: IdentityDirectoryReader;
  readFile?: IdentityFileReader;
}

export async function readJoinedSessionView(
  options: ReadJoinedSessionViewOptions,
): Promise<JoinedSessionView> {
  const directory = options.identityDirectory ?? getDefaultIdentityDirectory();
  const now = options.now ?? new Date();
  const freshnessThresholds = resolveIdentityFreshnessThresholds(
    options.identityFreshnessThresholds,
  );
  const readdirImpl = (options.readdir ?? readdir) as IdentityDirectoryReader;
  const readFileImpl = (options.readFile ?? readFile) as IdentityFileReader;
  const diagnostics: JoinedDiagnostic[] = [];

  // Read identity records
  const identityRecords: Map<string, SessionIdentityRecord> = new Map();
  let identityEntries: Dirent<string>[];
  try {
    identityEntries = await readdirImpl(directory, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      diagnostics.push({
        code: 'identity_read_error',
        message: `Failed to read identity directory: ${getErrorMessage(error)}`,
      });
    }
    identityEntries = [];
  }

  for (const entry of identityEntries) {
    if (!entry.isFile() || !isIdentityRecordFile(entry.name)) {
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
        diagnostics.push({
          code: 'identity_read_error',
          message: `Failed to read identity record: ${getErrorMessage(error)}`,
          runtimeId,
        });
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      diagnostics.push({
        code: 'malformed_identity_record' as IdentityDiagnosticCode,
        message: `Ignored malformed JSON: ${getErrorMessage(error)}`,
        runtimeId,
      });
      continue;
    }

    const record = normalizeIdentityRecord(parsed);
    if (record === null) {
      diagnostics.push({
        code: 'malformed_identity_record' as IdentityDiagnosticCode,
        message: 'Ignored malformed record: expected runtimeId and identityUpdatedAt',
        runtimeId,
      });
      continue;
    }

    identityRecords.set(record.runtimeId, record);
  }

  // Join presence records with identity records
  const joinedRecords: JoinedSessionRecord[] = [];
  const matchedRuntimeIds = new Set<string>();

  for (const presence of options.presenceView.records) {
    const identity = identityRecords.get(presence.runtimeId);
    matchedRuntimeIds.add(presence.runtimeId);

    const joined = joinRecord(presence, identity, now, freshnessThresholds);
    joinedRecords.push(joined);
  }

  // Track orphan identity records (identity without matching presence)
  for (const [orphanRuntimeId] of identityRecords) {
    if (!matchedRuntimeIds.has(orphanRuntimeId)) {
      diagnostics.push({
        code: 'orphan_identity' as IdentityDiagnosticCode,
        message: 'Identity record has no matching presence runtime',
        runtimeId: orphanRuntimeId,
      });
    }
  }

  // Carry over presence diagnostics
  for (const diag of options.presenceView.diagnostics) {
    const joinedDiag: JoinedDiagnostic = {
      code: diag.code as PresenceDiagnosticCode,
      message: diag.message,
    };
    if (diag.filePath !== undefined) {
      joinedDiag.filePath = diag.filePath;
    }
    diagnostics.push(joinedDiag);
  }

  return { records: joinedRecords, diagnostics };
}

function joinRecord(
  presence: PresenceSummary,
  identity: SessionIdentityRecord | undefined,
  now: Date,
  thresholds: IdentityFreshnessThresholds,
): JoinedSessionRecord {
  const nowMs = now.getTime();
  const recordDiagnostics: JoinedDiagnostic[] = [];

  if (identity === undefined) {
    recordDiagnostics.push({
      code: 'identity_missing',
      message: 'No identity record for this runtime',
      runtimeId: presence.runtimeId,
    });
  }

  const joinedRecord: JoinedSessionRecord = {
    runtimeId: presence.runtimeId,
    pid: presence.pid,
    presenceState: presence.presenceState,
    heartbeatAt: presence.heartbeatAt,
    heartbeatAgeMs: presence.heartbeatAgeMs,
    startedAt: presence.startedAt,

    // Identity fields
    sessionId: identity?.sessionId ?? null,
    sessionFile: identity?.sessionFile ?? null,
    cwd: identity?.cwd ?? null,
    worktree: identity?.worktree ?? null,
    branch: identity?.branch ?? null,
    prUrl: identity?.prUrl ?? null,
    identityUpdatedAt: identity?.identityUpdatedAt ?? null,
    identityFreshness: computeIdentityFreshness(identity, nowMs, thresholds),

    diagnostics: recordDiagnostics,
  };

  if (presence.reason !== undefined) {
    joinedRecord.presenceReason = presence.reason;
  }

  return joinedRecord;
}

export function computeIdentityFreshness(
  identity: SessionIdentityRecord | undefined,
  nowMs: number,
  thresholds: IdentityFreshnessThresholds = DEFAULT_IDENTITY_FRESHNESS_THRESHOLDS,
): IdentityFreshness {
  if (identity === undefined) {
    return 'missing';
  }

  const updatedAtMs = Date.parse(identity.identityUpdatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return 'missing';
  }

  const ageMs = Math.max(0, nowMs - updatedAtMs);
  if (ageMs <= thresholds.freshAfterMs) {
    return 'fresh';
  }

  if (ageMs <= thresholds.staleAfterMs) {
    return 'stale';
  }

  return 'very_stale';
}

function normalizeIdentityRecord(candidate: unknown): SessionIdentityRecord | null {
  if (!isObject(candidate)) {
    return null;
  }

  const runtimeId = candidate['runtimeId'];
  if (typeof runtimeId !== 'string' || runtimeId.length === 0) {
    return null;
  }

  const identityUpdatedAt = candidate['identityUpdatedAt'];
  if (typeof identityUpdatedAt !== 'string') {
    return null;
  }

  return {
    runtimeId,
    sessionId: normalizeStringField(candidate['sessionId']),
    sessionFile: normalizeStringField(candidate['sessionFile']),
    cwd: normalizeStringField(candidate['cwd']),
    worktree: normalizeStringField(candidate['worktree']),
    branch: normalizeStringField(candidate['branch']),
    prUrl: normalizeStringField(candidate['prUrl']),
    identityUpdatedAt,
    sessionStartedAt: ensureString(candidate['sessionStartedAt']),
    gitRemote: normalizeStringField(candidate['gitRemote']),
    gitRoot: normalizeStringField(candidate['gitRoot']),
    identitySource: ensureString(candidate['identitySource']),
  };
}

function normalizeStringField(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function ensureString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return '';
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
