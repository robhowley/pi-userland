import { basename } from 'node:path';
import type { SessionDeckBrowserRecord } from './browser-view.js';
import type { SessionDeckDiagnostic, SessionDeckRecord, SessionDeckSnapshot } from './types.js';

export interface SessionDeckRecordRenderOptions {
  all: boolean;
  showIdentity: boolean;
}

export interface SessionDeckBrowserRow {
  icon: string;
  activity: string;
  title: string;
  titleSource: 'terminalDisplay' | 'sessionName' | 'repoName' | 'cwd' | 'runtimeId';
  repoLabel: string | null;
  prLabel: string | null;
  ageLabel: string;
  branchLabel: string | null;
  chipPreview: string;
  hasChips: boolean;
  childLabel: string | null;
  terminalLabel: string | null;
  terminalOpenLabel: string | null;
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

  const childRuntimeLine = formatChildRuntimeLine(record);
  if (childRuntimeLine !== null) {
    lines.push(`  ${childRuntimeLine}`);
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

export function formatSessionDeckBrowserRow(
  record: SessionDeckBrowserRecord,
): SessionDeckBrowserRow {
  const title = getDisplayTitle(record);

  return {
    icon: formatActivityGlyph(record.activityState),
    activity: formatListActivity(record),
    title: title.text,
    titleSource: title.source,
    repoLabel: getRepoLabel(record, title.source),
    prLabel: formatPr(record.prUrl),
    ageLabel: formatDuration(getListAgeMs(record)),
    branchLabel: formatListBranch(record.branch),
    chipPreview: formatChipPreview(record.chips),
    hasChips: record.chips.length > 0,
    childLabel: formatChildRuntimeLabel(record),
    terminalLabel: record.terminalDisplay?.detail ?? null,
    terminalOpenLabel: record.terminalDisplay?.openLabel ?? null,
  };
}

export function formatSessionDeckBrowserCardLines(
  record: SessionDeckBrowserRecord,
  options: SessionDeckRecordRenderOptions,
): string[] {
  const title = getDisplayTitle(record);
  const lines = [title.text];

  const repoLine = formatCardRepoLine(record, title.text);
  if (repoLine !== null) {
    lines.push(repoLine);
  }

  if (record.cwd !== null) {
    lines.push(`cwd: ${shortenHomePath(record.cwd)}`);
  }

  const checkoutLine = formatCardCheckoutLine(record);
  if (checkoutLine !== null) {
    lines.push(checkoutLine);
  }

  const branchAndPrLine = formatCardBranchAndPrLine(record);
  if (branchAndPrLine !== null) {
    lines.push(branchAndPrLine);
  }

  lines.push(formatCardStatusLine(record));

  const childRuntimeLine = formatChildRuntimeLine(record);
  if (childRuntimeLine !== null) {
    lines.push(childRuntimeLine);
  }

  if (record.terminalDisplay !== undefined) {
    lines.push(`terminal: ${record.terminalDisplay.detail}`);
    lines.push(`open: ${record.terminalDisplay.openLabel}`);
  }

  if (record.chips.length > 0) {
    lines.push('');
    lines.push(`chips: ${formatChipPreview(record.chips)}`);
  }

  const sessionAndPidLine = formatSessionAndPidLine(record);
  if (sessionAndPidLine !== null) {
    lines.push(sessionAndPidLine);
  }
  lines.push(formatRuntimeLine(record));

  const diagnosticsLine = options.all ? formatRecordDiagnostics(record.diagnostics) : null;
  if (diagnosticsLine !== null) {
    lines.push(diagnosticsLine);
  }

  return lines;
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

function getDisplayTitle(record: SessionDeckBrowserRecord): {
  text: string;
  source: SessionDeckBrowserRow['titleSource'];
} {
  if (record.terminalDisplay?.title !== undefined) {
    return { text: record.terminalDisplay.title, source: 'terminalDisplay' };
  }

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
  record: SessionDeckBrowserRecord,
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

function formatActivityGlyph(state: SessionDeckRecord['activityState']): string {
  switch (state) {
    case 'idle':
      return '○';
    case 'thinking':
      return '◒';
    case 'tool-running':
      return '◆';
    case 'error':
      return '!';
    case 'unknown':
      return '?';
  }
}

interface SessionDeckActivityDisplay {
  label: string;
  detail: string | null;
  cardAgeLabel: string | null;
  summaryAgeLabel: string | null;
  summaryDetailSeparator: ': ' | null;
}

function formatListActivity(record: SessionDeckRecord): string {
  return getActivityDisplay(record).label;
}

function formatSelectedActivity(record: SessionDeckRecord): string {
  const activity = getActivityDisplay(record);
  return joinDisplayParts(activity.label, activity.detail, activity.cardAgeLabel);
}

function getActivityDisplay(record: SessionDeckRecord): SessionDeckActivityDisplay {
  const ageLabel = formatOptionalDuration(record.activityAgeMs);

  switch (record.activityState) {
    case 'idle':
      return {
        label: 'idle',
        detail: null,
        cardAgeLabel: null,
        summaryAgeLabel: null,
        summaryDetailSeparator: null,
      };
    case 'thinking':
      return {
        label: 'thinking',
        detail: null,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: ageLabel,
        summaryDetailSeparator: null,
      };
    case 'tool-running':
      return {
        label: 'tool-running',
        detail: record.currentToolName,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: ageLabel,
        summaryDetailSeparator: ': ',
      };
    case 'error':
      return {
        label: 'error',
        detail: record.lastError,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: null,
        summaryDetailSeparator: ': ',
      };
    case 'unknown':
      return {
        label: 'unknown',
        detail: null,
        cardAgeLabel: ageLabel,
        summaryAgeLabel: null,
        summaryDetailSeparator: null,
      };
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

function formatCardRepoLine(record: SessionDeckRecord, title: string): string | null {
  const repo = record.qualifiedRepoName ?? record.repoName;
  if (repo === null) {
    return null;
  }

  if (record.qualifiedRepoName === null && repo === title) {
    return null;
  }

  return `repo: ${repo}`;
}

function formatCardCheckoutLine(record: SessionDeckRecord): string | null {
  if (record.isLinkedWorktree !== true) {
    return null;
  }

  return joinDisplayParts('checkout: worktree', record.worktreeLabel);
}

function formatCardBranchAndPrLine(record: SessionDeckRecord): string | null {
  const pr = formatPr(record.prUrl);
  const parts = [
    record.branch === null ? null : `branch: ${record.branch}`,
    pr === null ? null : `pr: ${pr}`,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatCardStatusLine(record: SessionDeckRecord): string {
  return joinDisplayParts(
    `presence: ${formatPresenceIcon(record.presenceState)} ${record.presenceState}`,
    `activity: ${formatSelectedActivity(record)}`,
    `heartbeat: ${formatCardHeartbeat(record)}`,
  );
}

function formatCardHeartbeat(record: SessionDeckRecord): string {
  return `${formatDuration(record.heartbeatAgeMs)} ago${formatPresenceReasonSuffix(record)}`;
}

function formatSessionAndPidLine(record: SessionDeckRecord): string | null {
  if (record.sessionId === null) {
    return null;
  }

  return record.pid === null
    ? `session: ${record.sessionId}`
    : `session: ${record.sessionId} · pid: ${record.pid}`;
}

function formatRuntimeLine(record: SessionDeckRecord): string {
  return record.sessionId === null && record.pid !== null
    ? `runtime: ${record.runtimeId} · pid: ${record.pid}`
    : `runtime: ${record.runtimeId}`;
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

function formatChildRuntimeLine(record: SessionDeckRecord): string | null {
  const label = formatChildRuntimeLabel(record);
  return label === null ? null : `child runtime: ${label.replace(/^child: /u, '')}`;
}

function formatChildRuntimeLabel(record: SessionDeckRecord): string | null {
  const childRuntime = record.derivedFacets?.childRuntime;
  if (childRuntime === undefined || !isUsefulChildRuntimeConfidence(childRuntime.confidence)) {
    return null;
  }

  const evidenceLabels = childRuntime.evidence
    .filter((evidence) => evidence.confidence !== 'low')
    .map((evidence) => formatChildRuntimeEvidence(evidence.code))
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .slice(0, 2);
  const via = evidenceLabels.length === 0 ? '' : ` via ${evidenceLabels.join(' + ')}`;
  const parent =
    childRuntime.parentRuntimeId === undefined
      ? ''
      : ` · parent ${formatShortId(childRuntime.parentRuntimeId)}`;

  return `child: ${childRuntime.confidence}${via}${parent}`;
}

function isUsefulChildRuntimeConfidence(confidence: string): boolean {
  return confidence === 'medium' || confidence === 'high' || confidence === 'explicit';
}

function formatChildRuntimeEvidence(code: string): string {
  switch (code) {
    case 'explicit_header_parent':
      return 'header parent';
    case 'inherited_deck_runtime':
      return 'deck env';
    case 'process_ancestor_match':
      return 'process ancestor';
    case 'started_during_parent_tool':
      return 'parent tool';
    case 'same_terminal':
      return 'same terminal';
    case 'headless_in_memory':
      return 'headless in-memory';
    case 'automation_input_source':
      return 'automation input';
    default:
      return code.replaceAll('_', ' ');
  }
}

function formatTextIdentityDetails(record: SessionDeckRecord): string | null {
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
  const activity = getActivityDisplay(record);
  const lead =
    activity.detail === null || activity.summaryDetailSeparator === null
      ? activity.label
      : `${activity.label}${activity.summaryDetailSeparator}${activity.detail}`;

  return joinSpaceParts(lead, activity.summaryAgeLabel);
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

function joinSpaceParts(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join(' ');
}

function joinDisplayParts(...parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null && part.length > 0).join(' · ');
}
