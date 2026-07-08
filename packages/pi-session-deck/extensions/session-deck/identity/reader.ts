import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_IDENTITY_FRESHNESS_THRESHOLDS,
  resolveIdentityFreshnessThresholds,
} from './constants.js';
import { normalizeSessionHeaderMetadata, normalizeSessionStartMetadata } from './metadata.js';
import { getDefaultIdentityDirectory, isIdentityRecordFile } from './store.js';
import type {
  IdentityDiagnostic,
  IdentityDiagnosticCode,
  IdentityFreshness,
  IdentityFreshnessThresholds,
  JoinedDiagnostic,
  JoinedSessionRecord,
  JoinedSessionView,
  SessionDerivedFacets,
  SessionHeaderMetadata,
  SessionIdentityRecord,
  SessionStartMetadata,
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
        filePath: directory,
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
          filePath,
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
        filePath,
      });
      continue;
    }

    const record = normalizeIdentityRecord(parsed);
    if (record === null) {
      diagnostics.push({
        code: 'malformed_identity_record' as IdentityDiagnosticCode,
        message: 'Ignored malformed record: expected runtimeId and identityUpdatedAt',
        runtimeId,
        filePath,
      });
      continue;
    }

    if (record.runtimeId !== runtimeId) {
      diagnostics.push({
        code: 'malformed_identity_record' as IdentityDiagnosticCode,
        message: 'Ignored malformed record: runtimeId does not match filename',
        runtimeId,
        filePath,
      });
      continue;
    }

    identityRecords.set(runtimeId, record);
  }

  // Join presence records with identity records
  const joinedRecords: JoinedSessionRecord[] = [];
  const matchedRuntimeIds = new Set<string>();

  for (const presence of options.presenceView.records) {
    const identity = identityRecords.get(presence.runtimeId);
    matchedRuntimeIds.add(presence.runtimeId);

    const joined = joinRecord(presence, identity, now, freshnessThresholds);
    joinedRecords.push(joined);
    diagnostics.push(...joined.diagnostics);
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
  } else if (identity.diagnostics !== undefined) {
    for (const diagnostic of identity.diagnostics) {
      recordDiagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        runtimeId: diagnostic.runtimeId ?? presence.runtimeId,
        ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
      });
    }
  }

  const sessionId = identity?.sessionId ?? null;
  const sessionFile = identity?.sessionFile ?? null;
  const cwd = identity?.cwd ?? null;
  const sessionStart = identity?.sessionStart;
  const sessionHeader = identity?.sessionHeader;

  const joinedRecord: JoinedSessionRecord = {
    runtimeId: presence.runtimeId,
    pid: presence.pid,
    presenceState: presence.presenceState,
    heartbeatAt: presence.heartbeatAt,
    heartbeatAgeMs: presence.heartbeatAgeMs,
    startedAt: presence.startedAt,

    // Identity fields
    sessionId,
    sessionFile,
    sessionName: identity?.sessionName ?? null,
    cwd,
    worktree: identity?.worktree ?? null,
    repoName: identity?.repoName ?? null,
    qualifiedRepoName: identity?.qualifiedRepoName ?? null,
    branch: identity?.branch ?? null,
    prUrl: identity?.prUrl ?? null,
    isLinkedWorktree: identity?.isLinkedWorktree ?? null,
    worktreeLabel: identity?.worktreeLabel ?? null,
    identityUpdatedAt: identity?.identityUpdatedAt ?? null,
    identityFreshness: computeIdentityFreshness(identity, nowMs, thresholds),
    derivedFacets: deriveSessionDerivedFacets({
      hasIdentity: identity !== undefined,
      sessionId,
      sessionFile,
      cwd,
      sessionStart,
      sessionHeader,
    }),
    ...(sessionStart === undefined ? {} : { sessionStart }),
    ...(sessionHeader === undefined ? {} : { sessionHeader }),

    diagnostics: recordDiagnostics,
  };

  if (presence.reason !== undefined) {
    joinedRecord.presenceReason = presence.reason;
  }

  return joinedRecord;
}

interface DerivedFacetInput {
  hasIdentity: boolean;
  sessionId: string | null;
  sessionFile: string | null;
  cwd: string | null;
  sessionStart: SessionStartMetadata | undefined;
  sessionHeader: SessionHeaderMetadata | undefined;
}

function deriveSessionDerivedFacets(input: DerivedFacetInput): SessionDerivedFacets {
  return {
    persistence: derivePersistenceFacet(input),
    interactivity: deriveInteractivityFacet(input.sessionStart),
    startCause: deriveStartCauseFacet(input.sessionStart),
    parentage: deriveParentageFacet(input.sessionHeader),
    identityStrength: deriveIdentityStrengthFacet(input),
    headerConsistency: deriveHeaderConsistencyFacet(input),
  };
}

function derivePersistenceFacet(input: DerivedFacetInput): SessionDerivedFacets['persistence'] {
  if (input.sessionFile !== null) {
    return 'file_backed';
  }

  return input.hasIdentity ? 'in_memory' : 'unknown';
}

function deriveInteractivityFacet(
  sessionStart: SessionStartMetadata | undefined,
): SessionDerivedFacets['interactivity'] {
  if (sessionStart?.hasUI === true) {
    return 'interactive';
  }

  if (sessionStart?.hasUI === false) {
    return 'headless';
  }

  switch (sessionStart?.mode) {
    case 'tui':
    case 'rpc':
      return 'interactive';
    case 'json':
    case 'print':
      return 'headless';
    default:
      return 'unknown';
  }
}

function deriveStartCauseFacet(
  sessionStart: SessionStartMetadata | undefined,
): SessionDerivedFacets['startCause'] {
  switch (sessionStart?.reason) {
    case 'startup':
    case 'reload':
    case 'new':
    case 'resume':
    case 'fork':
      return sessionStart.reason;
    case undefined:
      return 'unknown';
    default:
      return 'other';
  }
}

function deriveParentageFacet(
  sessionHeader: SessionHeaderMetadata | undefined,
): SessionDerivedFacets['parentage'] {
  if (sessionHeader === undefined) {
    return 'unknown';
  }

  return sessionHeader.parentSession === undefined ? 'root' : 'child';
}

function deriveIdentityStrengthFacet(
  input: DerivedFacetInput,
): SessionDerivedFacets['identityStrength'] {
  if (input.sessionId !== null && input.sessionHeader?.id !== undefined) {
    if (input.sessionHeader.id !== input.sessionId) {
      return 'conflicted';
    }
  }

  if (input.sessionId !== null && input.sessionFile !== null) {
    return 'strong';
  }

  if (input.sessionId !== null || input.sessionFile !== null || input.sessionHeader !== undefined) {
    return 'weak';
  }

  return 'missing';
}

function deriveHeaderConsistencyFacet(
  input: DerivedFacetInput,
): SessionDerivedFacets['headerConsistency'] {
  const header = input.sessionHeader;
  if (header === undefined) {
    return 'unavailable';
  }

  const comparisons: Array<{ headerValue: string; identityValue: string }> = [];

  if (input.sessionId !== null) {
    comparisons.push({ headerValue: header.id, identityValue: input.sessionId });
  }

  if (input.cwd !== null) {
    comparisons.push({ headerValue: header.cwd, identityValue: input.cwd });
  }

  const hasFullBasis = comparisons.length === 2;

  if (comparisons.some(({ headerValue, identityValue }) => headerValue !== identityValue)) {
    return 'mismatch';
  }

  if (!hasFullBasis) {
    return 'indeterminate';
  }

  return 'consistent';
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

  const diagnostics = normalizeDiagnostics(candidate['diagnostics']);
  const sessionName = normalizeStringField(candidate['sessionName']);
  const sessionStart = normalizeSessionStartMetadata(candidate['sessionStart']);
  const sessionHeader = normalizeSessionHeaderMetadata(candidate['sessionHeader']);

  return {
    runtimeId,
    sessionId: normalizeStringField(candidate['sessionId']),
    sessionFile: normalizeStringField(candidate['sessionFile']),
    ...(sessionName === null ? {} : { sessionName }),
    cwd: normalizeStringField(candidate['cwd']),
    worktree: normalizeStringField(candidate['worktree']),
    repoName: normalizeStringField(candidate['repoName']),
    qualifiedRepoName: normalizeStringField(candidate['qualifiedRepoName']),
    branch: normalizeStringField(candidate['branch']),
    prUrl: normalizeStringField(candidate['prUrl']),
    isLinkedWorktree: normalizeBooleanOrNullField(candidate['isLinkedWorktree']),
    worktreeLabel: normalizeStringField(candidate['worktreeLabel']),
    identityUpdatedAt,
    sessionStartedAt: ensureString(candidate['sessionStartedAt']),
    gitRemote: normalizeStringField(candidate['gitRemote']),
    gitRoot: normalizeStringField(candidate['gitRoot']),
    identitySource: ensureString(candidate['identitySource']),
    ...(sessionStart === undefined ? {} : { sessionStart }),
    ...(sessionHeader === undefined ? {} : { sessionHeader }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function normalizeDiagnostics(value: unknown): IdentityDiagnostic[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const diagnostics = value
    .map((entry) => normalizeDiagnostic(entry))
    .filter((entry): entry is IdentityDiagnostic => entry !== null);

  return diagnostics.length > 0 ? diagnostics : undefined;
}

function normalizeDiagnostic(value: unknown): IdentityDiagnostic | null {
  if (!isObject(value)) {
    return null;
  }

  const code = value['code'];
  const message = value['message'];
  if (typeof code !== 'string' || typeof message !== 'string') {
    return null;
  }

  return {
    code: code as IdentityDiagnostic['code'],
    message,
    ...(typeof value['runtimeId'] === 'string' ? { runtimeId: value['runtimeId'] } : {}),
    ...(typeof value['filePath'] === 'string' ? { filePath: value['filePath'] } : {}),
  };
}

function normalizeStringField(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function normalizeBooleanOrNullField(value: unknown): boolean | null {
  if (value === true) {
    return true;
  }

  if (value === false) {
    return false;
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
