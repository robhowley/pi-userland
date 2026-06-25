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
import type { SessionDeckRecord, SessionDeckSnapshot } from './types.js';

const DEFAULT_MAX_VISIBLE_ROWS = 6;

export interface SessionDeckBrowserOptions {
  all: boolean;
  showIdentity: boolean;
  initialView: SessionDeckSnapshot;
  onClose: () => void;
  reload: () => Promise<SessionDeckSnapshot>;
  requestRender: () => void;
  reapLines?: string[];
  theme: Theme;
}

export class SessionDeckBrowser {
  private readonly all: boolean;
  private readonly showIdentity: boolean;
  private readonly onClose: () => void;
  private readonly reload: () => Promise<SessionDeckSnapshot>;
  private readonly requestRender: () => void;
  private readonly reapLines: string[];
  private readonly theme: Theme;

  private view: SessionDeckSnapshot;
  private selectedIndex = 0;
  private detailVisible = true;
  private refreshError: string | null = null;
  private refreshPending: Promise<void> | null = null;
  private isRefreshing = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(options: SessionDeckBrowserOptions) {
    this.all = options.all;
    this.showIdentity = options.showIdentity;
    this.onClose = options.onClose;
    this.reload = options.reload;
    this.requestRender = options.requestRender;
    this.reapLines = options.reapLines ?? [];
    this.theme = options.theme;
    this.view = options.initialView;
    this.selectedIndex = clampIndex(0, this.view.records.length);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.detailVisible = !this.detailVisible;
      this.refreshError = null;
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

    if (matchesKey(data, 'up')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refreshError = null;
      this.bump();
      return;
    }

    if (matchesKey(data, 'down')) {
      this.selectedIndex = Math.min(this.view.records.length - 1, this.selectedIndex + 1);
      this.refreshError = null;
      this.bump();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const title = this.theme.fg(
      'accent',
      this.theme.bold(getSessionDeckBrowserTitle(this.view, this.all)),
    );
    const help = this.theme.fg('muted', '↑↓ move · enter details · r refresh · q close');

    pushWrappedLine(lines, title, width);
    pushWrappedLine(lines, help, width);

    if (this.isRefreshing) {
      pushWrappedLine(lines, this.theme.fg('muted', 'Refreshing session deck…'), width);
    } else if (this.refreshError !== null) {
      pushWrappedLine(
        lines,
        this.theme.fg('warning', `Refresh failed: ${this.refreshError}`),
        width,
      );
    }

    if (this.reapLines.length > 0) {
      lines.push('');
      for (const line of this.reapLines) {
        pushWrappedLine(lines, this.theme.fg('muted', line), width);
      }
    }

    lines.push('');

    if (this.view.records.length === 0) {
      pushWrappedLine(lines, getSessionDeckEmptyMessage(this.all), width);
    } else {
      const windowed = getVisibleWindow(
        this.view.records.length,
        DEFAULT_MAX_VISIBLE_ROWS,
        this.selectedIndex,
      );

      for (let index = windowed.start; index < windowed.end; index += 1) {
        const record = this.view.records[index]!;
        const row = formatSessionDeckBrowserRow(record);
        const isSelected = index === this.selectedIndex;

        lines.push(renderRowLine1(this.theme, record, row, isSelected, width));
        lines.push(renderRowLine2(this.theme, record, row, isSelected, width));
      }

      if (windowed.end - windowed.start < this.view.records.length) {
        pushWrappedLine(
          lines,
          this.theme.fg(
            'dim',
            `Showing ${windowed.start + 1}-${windowed.end} of ${this.view.records.length}`,
          ),
          width,
        );
      }
    }

    lines.push('');

    if (!this.detailVisible) {
      pushWrappedLine(lines, this.theme.fg('dim', 'Details hidden · Enter to show.'), width);
    } else {
      const selected = this.view.records[this.selectedIndex] ?? null;
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

  private async refresh(): Promise<void> {
    if (this.refreshPending !== null) {
      return this.refreshPending;
    }

    const selectedRuntimeId = this.view.records[this.selectedIndex]?.runtimeId ?? null;
    this.isRefreshing = true;
    this.refreshError = null;
    this.bump();

    this.refreshPending = (async () => {
      try {
        this.view = await this.reload();
        this.selectedIndex = findSelectedIndex(this.view, selectedRuntimeId);
      } catch (error) {
        this.refreshError = getErrorMessage(error);
      } finally {
        this.isRefreshing = false;
        this.refreshPending = null;
        this.bump();
      }
    })();

    return this.refreshPending;
  }

  private bump(): void {
    this.invalidate();
    this.requestRender();
  }
}

function renderRowLine1(
  theme: Theme,
  record: SessionDeckRecord,
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
  record: SessionDeckRecord,
  row: SessionDeckBrowserRow,
  isSelected: boolean,
  width: number,
): string {
  const prefix = isSelected ? theme.fg('accent', '  │ ') : '    ';
  const chipText = row.hasChips
    ? isSelected || !shouldDimSessionDeckBrowserRow(record)
      ? row.chipPreview
      : theme.fg('dim', row.chipPreview)
    : theme.fg('dim', 'no chips');

  return truncateToWidth(`${prefix}${chipText}`, width);
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
  record: SessionDeckRecord,
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
  record: SessionDeckRecord,
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

function findSelectedIndex(view: SessionDeckSnapshot, runtimeId: string | null): number {
  if (runtimeId === null) {
    return clampIndex(0, view.records.length);
  }

  const matchedIndex = view.records.findIndex((record) => record.runtimeId === runtimeId);
  return matchedIndex === -1 ? clampIndex(0, view.records.length) : matchedIndex;
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
