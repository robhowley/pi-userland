import { basename } from 'node:path';
import type { SessionDeckDiagnostic, SessionDeckRecord, SessionDeckSnapshot } from './types.js';

export interface SessionDeckRecordRenderOptions {
  all: boolean;
  showIdentity: boolean;
}

export interface SessionDeckBrowserRow {
  icon: string;
  activity: string;
  title: string;
  titleSource: 'sessionName' | 'repoName' | 'cwd' | 'runtimeId';
  repoLabel: string | null;
  prLabel: string | null;
  ageLabel: string;
  branchLabel: string | null;
  chipPreview: string;
  hasChips: boolean;
}

export function getSessionDeckListHeading(all: boolean): string {
  return all ? 'Pi sessions (all records)' : 'Pi sessions (live + stale)';
}

export function getSessionDeckBrowserTitle(view: SessionDeckSnapshot, all: boolean): string {
  const counts = countPresenceStates(view.records);
  const parts = ['Pi sessions', `${counts.live} live`, `${counts.stale} stale`];

  if (all) {
    parts.push(`${counts.dead} dead`, `${counts.unknown} unknown`);
  }

  return parts.join(' · ');
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
    lines.push(`  ${formatTextChipSummary(record.chips)}`);
  }

  const identityLine = options.showIdentity ? formatTextIdentityDetails(record) : null;
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

export function formatSessionDeckBrowserRow(record: SessionDeckRecord): SessionDeckBrowserRow {
  const title = getDisplayTitle(record);

  return {
    icon: formatPresenceIcon(record.presenceState),
    activity: formatListActivity(record),
    title: title.text,
    titleSource: title.source,
    repoLabel: getRepoLabel(record, title.source),
    prLabel: formatPr(record.prUrl),
    ageLabel: formatDuration(getListAgeMs(record)),
    branchLabel: formatListBranch(record.branch),
    chipPreview: formatChipPreview(record.chips),
    hasChips: record.chips.length > 0,
  };
}

export function formatSessionDeckBrowserCardLines(
  record: SessionDeckRecord,
  options: SessionDeckRecordRenderOptions,
): string[] {
  const title = getDisplayTitle(record);
  const sections: string[][] = [[title.text]];

  const locationLines = formatCardLocationLines(record, title.source);
  if (locationLines.length > 0) {
    sections.push(locationLines);
  }

  sections.push([
    `presence: ${formatPresenceIcon(record.presenceState)} ${record.presenceState}`,
    `activity: ${formatSelectedActivity(record)}`,
  ]);

  const pr = formatPr(record.prUrl);
  const metadataLines = [
    ...(record.branch === null ? [] : [`branch: ${record.branch}`]),
    ...(pr === null ? [] : [`pr: ${pr}`]),
  ];
  if (metadataLines.length > 0) {
    sections.push(metadataLines);
  }

  const chipLines = formatCardChipLines(record.chips);
  if (chipLines.length > 0) {
    sections.push(chipLines);
  }

  const debugLines = [
    `heartbeat: ${formatDuration(record.heartbeatAgeMs)} ago${formatPresenceReasonSuffix(record)}`,
    formatRuntimeLine(record),
  ];

  const identityLine = options.showIdentity ? formatCardIdentityDetails(record) : null;
  if (identityLine !== null) {
    debugLines.push(identityLine);
  }

  const diagnosticsLine = options.all ? formatRecordDiagnostics(record.diagnostics) : null;
  if (diagnosticsLine !== null) {
    debugLines.push(diagnosticsLine);
  }

  sections.push(debugLines);
  return joinSections(sections);
}

export function shouldDimSessionDeckBrowserRow(record: SessionDeckRecord): boolean {
  return record.presenceState !== 'live';
}

export function formatReapedRecord(filePath: string): string {
  const runtimeId = basename(filePath, '.json');
  return runtimeId.length > 0 ? runtimeId : filePath;
}

function countPresenceStates(
  records: SessionDeckRecord[],
): Record<SessionDeckRecord['presenceState'], number> {
  return records.reduce<Record<SessionDeckRecord['presenceState'], number>>(
    (counts, record) => {
      counts[record.presenceState] += 1;
      return counts;
    },
    {
      live: 0,
      stale: 0,
      dead: 0,
      unknown: 0,
    },
  );
}

function getDisplayTitle(record: SessionDeckRecord): {
  text: string;
  source: SessionDeckBrowserRow['titleSource'];
} {
  if (record.sessionName !== null) {
    return { text: record.sessionName, source: 'sessionName' };
  }

  if (record.repoName !== null) {
    return { text: record.repoName, source: 'repoName' };
  }

  const cwdBasename = getCwdBasename(record.cwd);
  if (cwdBasename !== null) {
    return { text: cwdBasename, source: 'cwd' };
  }

  return { text: formatShortId(record.runtimeId), source: 'runtimeId' };
}

function getRepoLabel(
  record: SessionDeckRecord,
  titleSource: SessionDeckBrowserRow['titleSource'],
): string | null {
  if (titleSource === 'repoName' || titleSource === 'cwd') {
    return null;
  }

  return record.repoName ?? getCwdBasename(record.cwd);
}

function formatPresenceIcon(state: SessionDeckRecord['presenceState']): string {
  switch (state) {
    case 'live':
      return '●';
    case 'stale':
      return '◌';
    case 'dead':
      return '×';
    case 'unknown':
      return '◇';
  }
}

function formatListActivity(record: SessionDeckRecord): string {
  switch (record.activityState) {
    case 'waiting':
      return 'waiting';
    case 'thinking':
      return 'thinking';
    case 'tool-running':
      return 'tool-running';
    case 'error':
      return 'error';
    case 'unknown':
      return 'unknown';
  }
}

function formatSelectedActivity(record: SessionDeckRecord): string {
  switch (record.activityState) {
    case 'waiting':
      return 'waiting';
    case 'thinking':
      return joinDisplayParts('thinking', formatOptionalDuration(record.activityAgeMs));
    case 'tool-running':
      return joinDisplayParts(
        'tool-running',
        record.currentToolName,
        formatOptionalDuration(record.activityAgeMs),
      );
    case 'error':
      return joinDisplayParts(
        'error',
        record.lastError,
        formatOptionalDuration(record.activityAgeMs),
      );
    case 'unknown':
      return joinDisplayParts('unknown', formatOptionalDuration(record.activityAgeMs));
  }
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

function formatCardLocationLines(
  record: SessionDeckRecord,
  titleSource: SessionDeckBrowserRow['titleSource'],
): string[] {
  const lines: string[] = [];

  if (record.repoName !== null && titleSource !== 'repoName') {
    lines.push(`repo: ${record.repoName}`);
  }

  if (record.cwd !== null) {
    lines.push(`cwd: ${shortenHomePath(record.cwd)}`);
  }

  return lines;
}

function formatCardChipLines(chips: string[]): string[] {
  if (chips.length === 0) {
    return [];
  }

  return ['chips:', ...chips.map((chip) => `  - ${chip}`)];
}

function formatRuntimeLine(record: SessionDeckRecord): string {
  return record.pid === null
    ? `runtime: ${record.runtimeId}`
    : `runtime: ${record.runtimeId} · pid: ${record.pid}`;
}

function formatRepoOrCwd(cwd: string | null, preferBasename: boolean): string | null {
  if (cwd === null) {
    return null;
  }

  const shortenedCwd = shortenHomePath(cwd);
  if (!preferBasename) {
    return shortenedCwd;
  }

  const cwdBasename = getCwdBasename(cwd);
  return cwdBasename ?? shortenedCwd;
}

function getCwdBasename(cwd: string | null): string | null {
  if (cwd === null) {
    return null;
  }

  const cwdBasename = basename(cwd);
  if (cwdBasename.length === 0 || cwdBasename === '/' || cwdBasename === '.') {
    return shortenHomePath(cwd);
  }

  return cwdBasename;
}

function formatPr(prUrl: string | null): string | null {
  if (prUrl === null) {
    return null;
  }

  const prMatch = prUrl.match(/\/pull\/(\d+)$/);
  return prMatch ? `#${prMatch[1]}` : prUrl;
}

function formatTextIdentityDetails(record: SessionDeckRecord): string | null {
  return record.sessionId !== null ? `session=${record.sessionId}` : null;
}

function formatCardIdentityDetails(record: SessionDeckRecord): string | null {
  return record.sessionId !== null ? `session: ${record.sessionId}` : null;
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

function formatTextChipSummary(chips: string[]): string {
  return chips.join(' | ');
}

function formatChipPreview(chips: string[]): string {
  return chips.join(' · ');
}

function formatPresenceReasonSuffix(record: SessionDeckRecord): string {
  if (record.presenceReason === undefined || record.presenceReason === 'fresh_heartbeat') {
    return '';
  }

  return ` · ${humanizePresenceReason(record.presenceReason)}`;
}

function humanizePresenceReason(reason: NonNullable<SessionDeckRecord['presenceReason']>): string {
  switch (reason) {
    case 'fresh_heartbeat':
      return 'fresh heartbeat';
    case 'heartbeat_expired':
      return 'heartbeat expired';
    case 'pid_missing':
      return 'pid missing';
    case 'pid_reused':
      return 'pid reused';
    case 'pid_unverified':
      return 'pid unverified';
    case 'future_timestamp':
      return 'future timestamp';
    case 'invalid_timestamp':
      return 'invalid timestamp';
    default:
      return reason;
  }
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

function getListAgeMs(record: SessionDeckRecord): number {
  if (record.presenceState === 'stale' || record.presenceState === 'dead') {
    return record.heartbeatAgeMs;
  }

  return record.activityAgeMs ?? record.heartbeatAgeMs;
}

function formatOptionalDuration(durationMs: number | null): string | null {
  return durationMs === null ? null : formatDuration(durationMs);
}

function formatListBranch(branch: string | null): string | null {
  return branch === null ? null : truncateMiddle(branch, 28);
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }

  const prefixLength = Math.ceil((maxLength - 1) / 2);
  const suffixLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, prefixLength)}…${value.slice(value.length - suffixLength)}`;
}

function joinDisplayParts(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join(' · ');
}

function joinSections(sections: string[][]): string[] {
  const lines: string[] = [];

  for (const section of sections) {
    if (section.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      lines.push('');
    }

    lines.push(...section);
  }

  return lines;
}
