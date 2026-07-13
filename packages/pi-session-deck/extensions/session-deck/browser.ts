import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import {
  formatSessionDeckBrowserCardLines,
  formatSessionDeckBrowserRow,
  formatSessionDeckDiagnosticLine,
  getSessionDeckBrowserTitle,
  getSessionDeckEmptyMessage,
  shouldDimSessionDeckBrowserRow,
} from './browser-render.js';
import type { SessionDeckBrowserRow } from './browser-render.js';
import type { SessionDeckBrowserRecord, SessionDeckBrowserSnapshot } from './browser-view.js';

const DEFAULT_MAX_VISIBLE_ROWS = 8;
const DEFAULT_MAX_VISIBLE_REPOS = 4;
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const ALL_REPO_FILTER_KEY = Symbol('all-repo-filter');
const NO_REPO_FILTER_KEY = Symbol('no-repo-filter');

type SessionDeckRefreshMode = 'manual' | 'auto';
type SessionDeckRepoKey = string | typeof ALL_REPO_FILTER_KEY | typeof NO_REPO_FILTER_KEY;
type SessionDeckNamedRepoFilter = {
  kind: 'named';
  key: string;
  shortLabel: string;
  qualifiedLabel: string | null;
};
type SessionDeckRepoFilter = { kind: 'all' } | { kind: 'no-repo' } | SessionDeckNamedRepoFilter;

interface SessionDeckRepoOption {
  key: SessionDeckRepoKey;
  label: string;
  filter: SessionDeckRepoFilter;
}

interface SessionDeckRepoState {
  options: SessionDeckRepoOption[];
  recordsByKey: Map<SessionDeckRepoKey, SessionDeckBrowserRecord[]>;
}

interface SessionDeckNamedRepoBucket {
  key: string;
  shortLabel: string;
  qualifiedLabel: string | null;
  records: SessionDeckBrowserRecord[];
}

interface SessionDeckPendingRepoGroup {
  shortLabel: string;
  qualifiedLabels: Set<string>;
  records: SessionDeckBrowserRecord[];
}

interface SessionDeckBrowserSelection {
  repoState: SessionDeckRepoState;
  repoIndex: number;
  repoOption: SessionDeckRepoOption;
  records: SessionDeckBrowserRecord[];
}

export interface SessionDeckBrowserOpenSelectedResult {
  ok: boolean;
  message: string;
}

export type SessionDeckBrowserOpenSelected = (
  record: SessionDeckBrowserRecord,
) => Promise<SessionDeckBrowserOpenSelectedResult>;

export interface SessionDeckBrowserOptions {
  all: boolean;
  showIdentity: boolean;
  initialView: SessionDeckBrowserSnapshot;
  onClose: () => void;
  openSelected?: SessionDeckBrowserOpenSelected;
  reload: () => Promise<SessionDeckBrowserSnapshot>;
  requestRender: () => void;
  reapLines?: string[];
  theme: Theme;
}

export class SessionDeckBrowser {
  private readonly all: boolean;
  private readonly showIdentity: boolean;
  private readonly onClose: () => void;
  private readonly openSelected: SessionDeckBrowserOpenSelected | null;
  private readonly reload: () => Promise<SessionDeckBrowserSnapshot>;
  private readonly requestRender: () => void;
  private readonly reapLines: string[];
  private readonly theme: Theme;

  private view: SessionDeckBrowserSnapshot;
  private selectedRepoKey: SessionDeckRepoKey = ALL_REPO_FILTER_KEY;
  private selectedIndex = 0;
  private detailVisible = true;
  private refreshStatus: { message: string; tone: 'muted' | 'warning' } | null = null;
  private openStatus: { message: string; tone: 'muted' | 'warning' } | null = null;
  private refreshPending: Promise<void> | null = null;
  private openPending: Promise<void> | null = null;
  private isRefreshing = false;
  private autoRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(options: SessionDeckBrowserOptions) {
    this.all = options.all;
    this.showIdentity = options.showIdentity;
    this.onClose = options.onClose;
    this.openSelected = options.openSelected ?? null;
    this.reload = options.reload;
    this.requestRender = options.requestRender;
    this.reapLines = options.reapLines ?? [];
    this.theme = options.theme;
    this.view = options.initialView;
    this.selectedIndex = clampIndex(0, this.view.records.length);
    this.startAutoRefresh();
  }

  handleInput(data: string): void {
    if (this.disposed) {
      return;
    }

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.dispose();
      this.onClose();
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.detailVisible = !this.detailVisible;
      this.clearStatus();
      this.bump();
      return;
    }

    if (matchesKey(data, 'r')) {
      void this.refresh();
      return;
    }

    if (this.view.records.length === 0) {
      return;
    }

    const selection = this.getSelection();
    const selectedRecord = selection.records[this.selectedIndex] ?? null;

    if (matchesKey(data, 'o')) {
      if (selectedRecord !== null) {
        void this.openSelectedRecord(selectedRecord);
      }
      return;
    }

    if (matchesKey(data, 'left')) {
      this.switchRepo(-1, selection);
      return;
    }

    if (matchesKey(data, 'right')) {
      this.switchRepo(1, selection);
      return;
    }

    if (matchesKey(data, 'up')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.clearStatus();
      this.bump();
      return;
    }

    if (matchesKey(data, 'down')) {
      this.selectedIndex = Math.min(selection.records.length - 1, this.selectedIndex + 1);
      this.clearStatus();
      this.bump();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const selection = this.getSelection();
    const lines: string[] = [];
    const title = this.theme.fg(
      'accent',
      this.theme.bold(getSessionDeckBrowserTitle(this.view, this.all)),
    );
    const help = this.theme.fg(
      'muted',
      '↑↓ move · ←→ switch repo · enter details · o open terminal · r refresh · q close',
    );

    pushWrappedLine(lines, title, width);
    pushWrappedLine(lines, help, width);

    if (this.isRefreshing) {
      pushWrappedLine(lines, this.theme.fg('muted', 'Refreshing session deck…'), width);
    } else if (this.refreshStatus !== null) {
      pushWrappedLine(
        lines,
        this.theme.fg(this.refreshStatus.tone, this.refreshStatus.message),
        width,
      );
    }

    if (this.openStatus !== null) {
      pushWrappedLine(lines, this.theme.fg(this.openStatus.tone, this.openStatus.message), width);
    }

    if (this.reapLines.length > 0) {
      lines.push('');
      for (const line of this.reapLines) {
        pushWrappedLine(lines, this.theme.fg('muted', line), width);
      }
    }

    if (this.view.records.length === 0) {
      lines.push('');
      pushWrappedLine(lines, getSessionDeckEmptyMessage(this.all), width);
    } else {
      lines.push(
        renderRepoRow(this.theme, selection.repoState.options, selection.repoIndex, width),
      );
      lines.push('');

      const windowed = getVisibleWindow(
        selection.records.length,
        DEFAULT_MAX_VISIBLE_ROWS,
        this.selectedIndex,
      );

      for (let index = windowed.start; index < windowed.end; index += 1) {
        const record = selection.records[index]!;
        const row = formatSessionDeckBrowserRow(record);
        const isSelected = index === this.selectedIndex;

        lines.push(renderRowLine1(this.theme, record, row, isSelected, width));
        lines.push(renderRowLine2(this.theme, record, row, isSelected, width));

        if (index < windowed.end - 1) {
          lines.push('');
        }
      }

      if (windowed.end - windowed.start < selection.records.length) {
        pushWrappedLine(
          lines,
          this.theme.fg(
            'dim',
            `Showing ${windowed.start + 1}-${windowed.end} of ${selection.records.length}`,
          ),
          width,
        );
      }
    }

    lines.push('');

    if (!this.detailVisible) {
      pushWrappedLine(lines, this.theme.fg('dim', 'Details hidden · Enter to show.'), width);
    } else {
      const selected = selection.records[this.selectedIndex] ?? null;
      if (selected === null) {
        pushWrappedLine(lines, this.theme.fg('dim', 'No selected session.'), width);
      } else {
        const cardLines = formatSessionDeckBrowserCardLines(selected, {
          all: this.all,
          showIdentity: this.showIdentity,
        });
        if (cardLines.length > 0) {
          cardLines[0] = this.theme.fg('accent', this.theme.bold(cardLines[0]!));
        }
        pushBoxedLines(lines, cardLines, width);
      }
    }

    if (this.all && this.view.diagnostics.length > 0) {
      lines.push('');
      pushWrappedLine(lines, this.theme.fg('muted', this.theme.bold('Diagnostics')), width);
      for (const diagnostic of this.view.diagnostics) {
        pushWrappedLine(lines, formatSessionDeckDiagnosticLine(diagnostic), width, '  ');
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.autoRefreshInterval !== null) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }

  private async openSelectedRecord(record: SessionDeckBrowserRecord): Promise<void> {
    if (this.disposed) {
      return;
    }

    const openSelected = this.openSelected;
    if (openSelected === null) {
      this.openStatus = {
        message: 'Terminal open requests are unavailable in this context.',
        tone: 'warning',
      };
      this.bump();
      return;
    }

    if (this.openPending !== null) {
      this.openStatus = { message: 'Already opening terminal…', tone: 'muted' };
      this.bump();
      return this.openPending;
    }

    this.openStatus = { message: 'Opening terminal…', tone: 'muted' };
    this.bump();

    this.openPending = (async () => {
      try {
        const result = await openSelected(record);
        if (this.disposed) {
          return;
        }

        this.openStatus = {
          message: result.message,
          tone: result.ok ? 'muted' : 'warning',
        };
      } catch (error) {
        if (this.disposed) {
          return;
        }

        this.openStatus = {
          message: `Failed to open terminal: ${getErrorMessage(error)}`,
          tone: 'warning',
        };
      } finally {
        this.openPending = null;
        this.bump();
      }
    })();

    return this.openPending;
  }

  private async refresh(mode: SessionDeckRefreshMode = 'manual'): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.refreshPending !== null) {
      return this.refreshPending;
    }

    if (mode === 'manual') {
      this.isRefreshing = true;
      this.refreshStatus = null;
      this.bump();
    }

    this.refreshPending = (async () => {
      try {
        const nextView = await this.reload();
        if (this.disposed) {
          return;
        }

        const selection = this.getSelection();
        const selectedRuntimeId = selection.records[this.selectedIndex]?.runtimeId ?? null;
        const nextRepoState = buildRepoState(nextView.records);
        const nextRepoOption = getPreservedRepoOption(nextRepoState, selection.repoOption.filter);

        this.view = nextView;
        this.selectedRepoKey = nextRepoOption.key;
        this.selectedIndex = findSelectedIndex(
          getRepoRecords(nextRepoState.recordsByKey, nextRepoOption.key),
          selectedRuntimeId,
        );
        this.refreshStatus = null;
      } catch (error) {
        if (this.disposed) {
          return;
        }

        this.refreshStatus =
          mode === 'manual'
            ? { message: `Refresh failed: ${getErrorMessage(error)}`, tone: 'warning' }
            : { message: `Auto refresh failed: ${getErrorMessage(error)}`, tone: 'muted' };
      } finally {
        this.isRefreshing = false;
        this.refreshPending = null;
        this.bump();
      }
    })();

    return this.refreshPending;
  }

  private startAutoRefresh(): void {
    this.autoRefreshInterval = setInterval(() => {
      void this.refresh('auto');
    }, AUTO_REFRESH_INTERVAL_MS);
    this.autoRefreshInterval.unref?.();
  }

  private switchRepo(direction: -1 | 1, selection: SessionDeckBrowserSelection): void {
    const nextRepoIndex = clampIndex(
      selection.repoIndex + direction,
      selection.repoState.options.length,
    );
    if (nextRepoIndex === selection.repoIndex) {
      return;
    }

    const selectedRuntimeId = selection.records[this.selectedIndex]?.runtimeId ?? null;
    const nextRepoKey = selection.repoState.options[nextRepoIndex]?.key;
    if (nextRepoKey === undefined) {
      return;
    }

    this.selectedRepoKey = nextRepoKey;
    this.selectedIndex = findSelectedIndex(
      getRepoRecords(selection.repoState.recordsByKey, nextRepoKey),
      selectedRuntimeId,
    );
    this.clearStatus();
    this.bump();
  }

  private getSelection(): SessionDeckBrowserSelection {
    return getRepoSelection(buildRepoState(this.view.records), this.selectedRepoKey);
  }

  private clearStatus(): void {
    this.refreshStatus = null;
    this.openStatus = null;
  }

  private bump(): void {
    if (this.disposed) {
      return;
    }

    this.invalidate();
    this.requestRender();
  }
}

function renderRepoRow(
  theme: Theme,
  options: SessionDeckRepoOption[],
  selectedIndex: number,
  width: number,
): string {
  if (options.length === 0) {
    return '';
  }

  const windowed = getVisibleWindow(options.length, DEFAULT_MAX_VISIBLE_REPOS, selectedIndex);
  const leftChevron = theme.fg(windowed.start === 0 ? 'dim' : 'muted', '‹');
  const rightChevron = theme.fg(windowed.end >= options.length ? 'dim' : 'muted', '›');
  const labels = options
    .slice(windowed.start, windowed.end)
    .map((option, index) =>
      windowed.start + index === selectedIndex ? theme.fg('accent', option.label) : option.label,
    );

  return layoutRepoRow(leftChevron, labels.join('  '), rightChevron, width);
}

function layoutRepoRow(
  leftChevron: string,
  labelText: string,
  rightChevron: string,
  width: number,
): string {
  const narrowRow = `${leftChevron}${rightChevron}`;
  if (width <= visibleWidth(narrowRow)) {
    return truncateToWidth(narrowRow, width);
  }

  const compactRow = `${leftChevron} ${rightChevron}`;
  if (width <= visibleWidth(compactRow)) {
    return truncateToWidth(compactRow, width);
  }

  const lead = `${leftChevron} `;
  const tail = ` ${rightChevron}`;
  const availableLabelWidth = Math.max(0, width - visibleWidth(lead) - visibleWidth(tail));
  const labels = availableLabelWidth === 0 ? '' : truncateToWidth(labelText, availableLabelWidth);
  return truncateToWidth(`${lead}${labels}${tail}`, width);
}

function renderRowLine1(
  theme: Theme,
  record: SessionDeckBrowserRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
  width: number,
): string {
  const prefix = isSelected ? '› ' : '  ';
  const lead = `${prefix}${row.icon} ${row.activity}  `;
  const coreMetadata = formatRowLine1Metadata(row, false);
  const availableTitleWidth = Math.max(1, width - visibleWidth(lead) - visibleWidth(coreMetadata));
  const title = truncateToWidth(styleRowTitle(theme, record, row, isSelected), availableTitleWidth);
  const line = appendBranchMetadata(
    `${lead}${title}${coreMetadata}`,
    row.branchLabel,
    coreMetadata.length > 0,
  );

  return styleRowLine1(theme, line, record, isSelected, width);
}

function renderRowLine2(
  theme: Theme,
  record: SessionDeckBrowserRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
  width: number,
): string {
  const prefix = isSelected ? theme.fg('accent', '  │ ') : '    ';
  const rowDetail = formatRowLine2Detail(row);
  const chipText = row.hasChips
    ? isSelected || !shouldDimSessionDeckBrowserRow(record)
      ? rowDetail
      : theme.fg('dim', rowDetail)
    : theme.fg('dim', rowDetail);

  return truncateToWidth(`${prefix}${chipText}`, width);
}

function formatRowLine2Detail(row: SessionDeckBrowserRow): string {
  if (row.terminalLabel === null) {
    return row.hasChips ? row.chipPreview : 'no chips';
  }

  return row.hasChips ? `${row.chipPreview} · ${row.terminalLabel}` : row.terminalLabel;
}

function formatRowLine1Metadata(row: SessionDeckBrowserRow, includeBranch: boolean): string {
  const tokens = [
    row.repoLabel,
    row.prLabel,
    row.ageLabel,
    ...(includeBranch ? [row.branchLabel] : []),
  ].filter((token): token is string => token !== null);

  return tokens.length === 0 ? '' : `  ${tokens.join(' · ')}`;
}

function appendBranchMetadata(
  line: string,
  branchLabel: string | null,
  hasCoreMetadata: boolean,
): string {
  if (branchLabel === null) {
    return line;
  }

  return `${line}${hasCoreMetadata ? ' · ' : '  '}${branchLabel}`;
}

function styleRowTitle(
  theme: Theme,
  record: SessionDeckBrowserRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
): string {
  if (isSelected || shouldDimSessionDeckBrowserRow(record) || row.titleSource !== 'sessionName') {
    return row.title;
  }

  return theme.fg('accent', row.title);
}

function styleRowLine1(
  theme: Theme,
  line: string,
  record: SessionDeckBrowserRecord,
  isSelected: boolean,
  width: number,
): string {
  const truncatedLine = truncateToWidth(line, width);

  if (isSelected) {
    return theme.fg('accent', truncatedLine);
  }

  if (shouldDimSessionDeckBrowserRow(record)) {
    return theme.fg('dim', truncatedLine);
  }

  return truncatedLine;
}

function pushWrappedLine(lines: string[], line: string, width: number, prefix = ''): void {
  const prefixWidth = visibleWidth(prefix);
  if (width <= prefixWidth) {
    lines.push(truncateToWidth(prefix, width));
    return;
  }

  const wrapped = wrapTextWithAnsi(line, Math.max(1, width - prefixWidth));
  if (wrapped.length === 0) {
    lines.push(truncateToWidth(prefix, width));
    return;
  }

  const continuationPrefix = ' '.repeat(prefixWidth);
  for (const [index, segment] of wrapped.entries()) {
    const currentPrefix = index === 0 ? prefix : continuationPrefix;
    lines.push(truncateToWidth(`${currentPrefix}${segment}`, width));
  }
}

function pushBoxedLines(lines: string[], contentLines: string[], width: number): void {
  if (width <= 4) {
    for (const line of contentLines) {
      pushWrappedLine(lines, line, width, '  ');
    }
    return;
  }

  const innerWidth = Math.max(1, width - 4);
  lines.push(truncateToWidth(`┌${'─'.repeat(Math.max(0, width - 2))}┐`, width));

  if (contentLines.length === 0) {
    lines.push(truncateToWidth(`│ ${' '.repeat(innerWidth)} │`, width));
  } else {
    for (const line of contentLines) {
      pushBoxedWrappedLine(lines, line, width, innerWidth);
    }
  }

  lines.push(truncateToWidth(`└${'─'.repeat(Math.max(0, width - 2))}┘`, width));
}

function pushBoxedWrappedLine(
  lines: string[],
  line: string,
  width: number,
  innerWidth: number,
): void {
  if (line.length === 0) {
    lines.push(truncateToWidth(`│ ${' '.repeat(innerWidth)} │`, width));
    return;
  }

  const wrapped = wrapTextWithAnsi(line, innerWidth);
  if (wrapped.length === 0) {
    lines.push(truncateToWidth(`│ ${' '.repeat(innerWidth)} │`, width));
    return;
  }

  for (const segment of wrapped) {
    lines.push(truncateToWidth(`│ ${padToVisibleWidth(segment, innerWidth)} │`, width));
  }
}

function padToVisibleWidth(line: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(line));
  return `${line}${' '.repeat(padding)}`;
}

function getVisibleWindow(
  total: number,
  maxVisible: number,
  selectedIndex: number,
): {
  start: number;
  end: number;
} {
  if (total <= maxVisible) {
    return { start: 0, end: total };
  }

  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, total - maxVisible));
  return {
    start,
    end: Math.min(total, start + maxVisible),
  };
}

function buildRepoState(records: SessionDeckBrowserRecord[]): SessionDeckRepoState {
  const recordsByKey = new Map<SessionDeckRepoKey, SessionDeckBrowserRecord[]>([
    [ALL_REPO_FILTER_KEY, records],
  ]);
  const repoGroups = new Map<string, SessionDeckPendingRepoGroup>();
  let noRepoRecords: SessionDeckBrowserRecord[] | null = null;

  for (const record of records) {
    const shortLabel = getRecordShortRepoLabel(record);
    if (shortLabel === null) {
      noRepoRecords ??= [];
      noRepoRecords.push(record);
      continue;
    }

    let group = repoGroups.get(shortLabel);
    if (group === undefined) {
      group = {
        shortLabel,
        qualifiedLabels: new Set<string>(),
        records: [],
      };
      repoGroups.set(shortLabel, group);
    }

    if (record.qualifiedRepoName !== null) {
      group.qualifiedLabels.add(record.qualifiedRepoName);
    }

    group.records.push(record);
  }

  const namedBuckets = [...repoGroups.values()]
    .flatMap(buildNamedRepoBuckets)
    .sort(compareRepoBuckets);
  const shortLabelCounts = countShortRepoLabels(namedBuckets);
  const options: SessionDeckRepoOption[] = [
    { key: ALL_REPO_FILTER_KEY, label: 'all', filter: { kind: 'all' } },
  ];

  for (const bucket of namedBuckets) {
    const label =
      (shortLabelCounts.get(bucket.shortLabel) ?? 0) > 1 && bucket.qualifiedLabel !== null
        ? bucket.qualifiedLabel
        : bucket.shortLabel;
    recordsByKey.set(bucket.key, bucket.records);
    options.push({
      key: bucket.key,
      label,
      filter: {
        kind: 'named',
        key: bucket.key,
        shortLabel: bucket.shortLabel,
        qualifiedLabel: bucket.qualifiedLabel,
      },
    });
  }

  if (noRepoRecords !== null && noRepoRecords.length > 0) {
    recordsByKey.set(NO_REPO_FILTER_KEY, noRepoRecords);
    options.push({ key: NO_REPO_FILTER_KEY, label: 'N/A', filter: { kind: 'no-repo' } });
  }

  return { options, recordsByKey };
}

function buildNamedRepoBuckets(group: SessionDeckPendingRepoGroup): SessionDeckNamedRepoBucket[] {
  if (group.qualifiedLabels.size <= 1) {
    const qualifiedLabel = group.qualifiedLabels.values().next().value ?? null;
    return [
      {
        key: group.shortLabel,
        shortLabel: group.shortLabel,
        qualifiedLabel,
        records: group.records,
      },
    ];
  }

  const qualifiedBuckets = new Map<string, SessionDeckNamedRepoBucket>();
  const unqualifiedRecords: SessionDeckBrowserRecord[] = [];

  for (const record of group.records) {
    if (record.qualifiedRepoName === null) {
      unqualifiedRecords.push(record);
      continue;
    }

    let bucket = qualifiedBuckets.get(record.qualifiedRepoName);
    if (bucket === undefined) {
      bucket = {
        key: record.qualifiedRepoName,
        shortLabel: group.shortLabel,
        qualifiedLabel: record.qualifiedRepoName,
        records: [],
      };
      qualifiedBuckets.set(record.qualifiedRepoName, bucket);
    }

    bucket.records.push(record);
  }

  return [
    ...qualifiedBuckets.values(),
    ...(unqualifiedRecords.length === 0
      ? []
      : [
          {
            key: group.shortLabel,
            shortLabel: group.shortLabel,
            qualifiedLabel: null,
            records: unqualifiedRecords,
          },
        ]),
  ];
}

function getRepoSelection(
  repoState: SessionDeckRepoState,
  selectedRepoKey: SessionDeckRepoKey,
): SessionDeckBrowserSelection {
  const repoIndex = repoState.options.findIndex((option) => option.key === selectedRepoKey);
  const resolvedRepoIndex = repoIndex === -1 ? 0 : repoIndex;
  const repoOption = repoState.options[resolvedRepoIndex] ?? {
    key: ALL_REPO_FILTER_KEY,
    label: 'all',
    filter: { kind: 'all' } as const,
  };

  return {
    repoState,
    repoIndex: resolvedRepoIndex,
    repoOption,
    records: getRepoRecords(repoState.recordsByKey, repoOption.key),
  };
}

function getRepoRecords(
  recordsByKey: Map<SessionDeckRepoKey, SessionDeckBrowserRecord[]>,
  repoKey: SessionDeckRepoKey,
): SessionDeckBrowserRecord[] {
  return recordsByKey.get(repoKey) ?? recordsByKey.get(ALL_REPO_FILTER_KEY) ?? [];
}

function countShortRepoLabels(buckets: Array<{ shortLabel: string }>): Map<string, number> {
  return buckets.reduce<Map<string, number>>((counts, bucket) => {
    counts.set(bucket.shortLabel, (counts.get(bucket.shortLabel) ?? 0) + 1);
    return counts;
  }, new Map());
}

function compareRepoBuckets(
  left: { key: string; shortLabel: string },
  right: { key: string; shortLabel: string },
): number {
  return (
    left.shortLabel.localeCompare(right.shortLabel, undefined, { sensitivity: 'base' }) ||
    left.key.localeCompare(right.key)
  );
}

function getRecordShortRepoLabel(record: SessionDeckBrowserRecord): string | null {
  if (record.repoName !== null) {
    return record.repoName;
  }

  if (record.qualifiedRepoName !== null) {
    return getShortRepoLabelFromKey(record.qualifiedRepoName);
  }

  return null;
}

function getShortRepoLabelFromKey(repoKey: string): string {
  const separatorIndex = repoKey.lastIndexOf('/');
  if (separatorIndex === -1 || separatorIndex === repoKey.length - 1) {
    return repoKey;
  }

  return repoKey.slice(separatorIndex + 1);
}

function getPreservedRepoOption(
  repoState: SessionDeckRepoState,
  filter: SessionDeckRepoFilter,
): SessionDeckRepoOption {
  if (filter.kind === 'all') {
    return repoState.options[0]!;
  }

  if (filter.kind === 'no-repo') {
    return (
      repoState.options.find((option) => option.key === NO_REPO_FILTER_KEY) ?? repoState.options[0]!
    );
  }

  if (filter.qualifiedLabel !== null) {
    const qualifiedMatch = repoState.options.find(
      (option): option is SessionDeckRepoOption & { filter: SessionDeckNamedRepoFilter } =>
        option.filter.kind === 'named' && option.filter.qualifiedLabel === filter.qualifiedLabel,
    );
    if (qualifiedMatch !== undefined) {
      return qualifiedMatch;
    }
  }

  const shortLabelMatches = repoState.options.filter(
    (option): option is SessionDeckRepoOption & { filter: SessionDeckNamedRepoFilter } =>
      option.filter.kind === 'named' && option.filter.shortLabel === filter.shortLabel,
  );
  if (shortLabelMatches.length === 1) {
    return shortLabelMatches[0]!;
  }

  return (
    repoState.options.find(
      (option): option is SessionDeckRepoOption & { filter: SessionDeckNamedRepoFilter } =>
        option.filter.kind === 'named' && option.filter.key === filter.key,
    ) ?? repoState.options[0]!
  );
}

function findSelectedIndex(records: SessionDeckBrowserRecord[], runtimeId: string | null): number {
  if (runtimeId === null) {
    return clampIndex(0, records.length);
  }

  const matchedIndex = records.findIndex((record) => record.runtimeId === runtimeId);
  return matchedIndex === -1 ? clampIndex(0, records.length) : matchedIndex;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(length - 1, index));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
