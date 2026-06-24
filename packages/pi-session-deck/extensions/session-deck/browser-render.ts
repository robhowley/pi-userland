import { basename } from 'node:path';
import type { SessionDeckDiagnostic, SessionDeckRecord } from './types.js';

export interface SessionDeckRecordRenderOptions {
  all: boolean;
  showIdentity: boolean;
}

export function getSessionDeckListHeading(all: boolean): string {
  return all ? 'Pi sessions (all records)' : 'Pi sessions (live + stale)';
}

export function getSessionDeckEmptyMessage(all: boolean): string {
  return all ? 'No session records found.' : 'No live or stale Pi sessions found.';
}

export function formatSessionDeckDiagnosticLine(diagnostic: SessionDeckDiagnostic): string {
  const location =
    diagnostic.runtimeId !== undefined
      ? ` runtime=${diagnostic.runtimeId}`
      : diagnostic.filePath !== undefined
        ? ` (${diagnostic.filePath})`
        : '';
  return `- ${diagnostic.code}${location}: ${diagnostic.message}`;
}

export function formatSessionDeckRecordSummary(record: SessionDeckRecord): string {
  return [
    formatShortId(record.runtimeId),
    formatActivitySummary(record),
    formatDuration(record.heartbeatAgeMs),
    ...formatPresenceDetails(record),
  ].join('  ');
}

export function formatSessionDeckRecordLines(
  record: SessionDeckRecord,
  options: SessionDeckRecordRenderOptions,
): string[] {
  const lines = [formatSessionDeckRecordSummary(record)];

  if (record.sessionName !== null) {
    lines.push(`  ${record.sessionName}`);
  }

  const contextLine = formatRecordContext(record);
  if (contextLine !== null) {
    lines.push(`  ${contextLine}`);
  }

  if (record.chips.length > 0) {
    lines.push(`  ${formatChips(record.chips)}`);
  }

  const identityLine = options.showIdentity ? formatIdentityDetails(record) : null;
  if (identityLine !== null) {
    lines.push(`  ${identityLine}`);
  }

  const diagnosticsLine = options.all ? formatRecordDiagnostics(record.diagnostics) : null;
  if (diagnosticsLine !== null) {
    lines.push(`  ${diagnosticsLine}`);
  }

  return lines;
}

export function formatSessionDeckRecord(
  record: SessionDeckRecord,
  options: SessionDeckRecordRenderOptions,
): string {
  return formatSessionDeckRecordLines(record, options).join('\n');
}

export function formatReapedRecord(filePath: string): string {
  const runtimeId = basename(filePath, '.json');
  return runtimeId.length > 0 ? runtimeId : filePath;
}

function formatPresenceDetails(record: SessionDeckRecord): string[] {
  const details: string[] = [];

  if (record.presenceState !== 'live') {
    details.push(record.presenceState);
  }

  if (record.presenceReason !== undefined && record.presenceReason !== 'fresh_heartbeat') {
    details.push(`reason=${record.presenceReason}`);
  }

  return details;
}

function formatRecordContext(record: SessionDeckRecord): string | null {
  const parts = [
    formatRepoOrCwd(record.cwd, record.branch !== null || record.prUrl !== null),
    record.branch,
    formatPr(record.prUrl),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join('  ') : null;
}

function formatRepoOrCwd(cwd: string | null, preferBasename: boolean): string | null {
  if (cwd === null) {
    return null;
  }

  const shortenedCwd = shortenHomePath(cwd);
  if (!preferBasename) {
    return shortenedCwd;
  }

  const repoName = basename(cwd);
  return repoName.length > 0 && repoName !== '/' && repoName !== '.' ? repoName : shortenedCwd;
}

function formatPr(prUrl: string | null): string | null {
  if (prUrl === null) {
    return null;
  }

  const prMatch = prUrl.match(/\/pull\/(\d+)$/);
  return prMatch ? `#${prMatch[1]}` : prUrl;
}

function formatIdentityDetails(record: SessionDeckRecord): string | null {
  return record.sessionId !== null ? `session=${record.sessionId}` : null;
}

function formatRecordDiagnostics(diagnostics: SessionDeckDiagnostic[]): string | null {
  if (diagnostics.length === 0) {
    return null;
  }

  return `diagnostics: ${[...new Set(diagnostics.map((diagnostic) => diagnostic.code))].join(' | ')}`;
}

function formatShortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function formatActivitySummary(record: SessionDeckRecord): string {
  switch (record.activityState) {
    case 'waiting':
      return 'waiting';
    case 'thinking':
      return record.activityAgeMs === null
        ? 'thinking'
        : `thinking ${formatDuration(record.activityAgeMs)}`;
    case 'tool-running': {
      const toolName = record.currentToolName === null ? '' : `: ${record.currentToolName}`;
      const age = record.activityAgeMs === null ? '' : ` ${formatDuration(record.activityAgeMs)}`;
      return `tool-running${toolName}${age}`;
    }
    case 'error':
      return record.lastError === null ? 'error' : `error: ${record.lastError}`;
    case 'unknown':
      return 'unknown';
  }
}

function formatChips(chips: string[]): string {
  return chips.join(' | ');
}

function shortenHomePath(cwd: string): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (home.length > 0 && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'n/a';
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }

  if (durationMs < 60 * 60_000) {
    return `${Math.round(durationMs / 60_000)}m`;
  }

  return `${Math.round(durationMs / (60 * 60_000))}h`;
}
