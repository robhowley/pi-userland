import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { ModelStats, ProviderStats, UsageSummary } from './types.js';
import { renderSpendBarChart } from './chart.js';
import { usageCache } from './cache.js';

const MIN_WIDTH = 44;

// Formatting utilities (shared, not class methods)
function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

export class UsageOverlayComponent {
  // Column width constants (shared across all tables for alignment)
  private static readonly COLS = {
    model: 30,
    spend: 9,
    tokens: 9,
    costPerM: 8,
    reqs: 7,
  };

  private static readonly TABLE_INNER_WIDTH =
    UsageOverlayComponent.COLS.model +
    2 +
    UsageOverlayComponent.COLS.spend +
    2 +
    UsageOverlayComponent.COLS.tokens +
    2 +
    UsageOverlayComponent.COLS.costPerM +
    2 +
    UsageOverlayComponent.COLS.reqs;

  private lines: string[];
  private theme: Theme;
  private onClose: () => void;
  private width: number;
  private summary: UsageSummary | null;
  private error: string | null;
  private cachedMinutesAgo: number | null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private requestRender: () => void;
  private isDisposed = false;

  constructor(
    summary: UsageSummary | null,
    error: string | null,
    cachedMinutesAgo: number | null,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
  ) {
    this.theme = theme;
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.summary = summary;
    this.error = error;
    this.cachedMinutesAgo = cachedMinutesAgo;
    this.width = this.calculateWidth(summary);
    this.lines = this.buildLines(summary, error, cachedMinutesAgo);

    // Set up timer to rebuild lines every 30 seconds to update "last refreshed" time
    this.refreshTimer = setInterval(() => {
      this.invalidate();
      // Force re-render by calling requestRender on the TUI
      // We need to store a reference to requestRender to do this
    }, 30000);
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  handleInput(data: string): void {
    // Close on q, escape, or ctrl+c
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
    }
  }

  render(width: number): string[] {
    // Center the overlay if terminal is wider
    // Width includes 2 extra characters for visual padding (1 space on each side)
    const padding = Math.max(0, Math.floor((width - this.width) / 2));
    const pad = ' '.repeat(padding);

    return this.lines.map((line) => truncateToWidth(pad + line, width));
  }

  invalidate(): void {
    if (this.isDisposed) return;
    // Rebuild lines to update "last refreshed" time from fresh cached data
    const freshSummary = usageCache.get('usage');
    this.lines = this.buildLines(freshSummary || this.summary, this.error, this.cachedMinutesAgo);
    // Only request render if still not disposed after potential async work
    if (!this.isDisposed) {
      this.requestRender();
    }
  }

  private calculateWidth(_summary: UsageSummary | null): number {
    // Use fixed table width for consistent layout across all views
    const innerWidth = UsageOverlayComponent.TABLE_INNER_WIDTH;
    return Math.max(MIN_WIDTH, innerWidth + 4) + 6; // +4 for borders, +6 for visual padding (3 on each side)
  }

  private buildLines(
    summary: UsageSummary | null,
    error: string | null,
    cachedMinutesAgo: number | null,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if (error) {
      lines.push(boxTop(this.width));
      lines.push(
        row(th.fg('accent', th.bold(' ◈ OpenRouter Usage  ·  /openrouter-usage')), this.width),
      );
      lines.push(emptyRow(this.width));
      lines.push(row(th.fg('error', error), this.width));
      if (cachedMinutesAgo !== null) {
        lines.push(
          row(th.fg('dim', `(last successful fetch: ${cachedMinutesAgo}m ago)`), this.width),
        );
      }
      lines.push(boxBottom(this.width));
      lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
      return lines;
    }

    if (!summary) {
      lines.push(boxTop(this.width));
      lines.push(
        row(th.fg('accent', th.bold(' ◈ OpenRouter Usage  ·  /openrouter-usage')), this.width),
      );
      lines.push(emptyRow(this.width));
      lines.push(row(th.fg('dim', 'No usage data available.'), this.width));
      lines.push(boxBottom(this.width));
      lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
      return lines;
    }

    // Summary view (subcommand views TODO)
    lines.push(boxTop(this.width));
    lines.push(
      row(th.fg('accent', th.bold(' ◈ OpenRouter Usage  ·  /openrouter-usage')), this.width),
    );
    lines.push(emptyRow(this.width));

    // Month row: amount stays with label, cap percentage right-aligned
    const monthLeftBase = ` Month $${fmt(summary.month)} / $${fmt(summary.cap)}`;
    const monthPercent = summary.cap > 0 ? Math.round((summary.month / summary.cap) * 100) : 0;
    const monthRightText = `cap (${monthPercent}%)`;
    const monthColor = monthPercent < 60 ? 'success' : monthPercent < 100 ? 'warning' : 'error';
    const monthRight =
      monthPercent >= 100
        ? th.bold(th.fg('error', monthRightText))
        : th.fg(monthColor, monthRightText);
    lines.push(rowRightAligned(monthLeftBase, monthRight + '  ', this.width));

    // 7d row: amount stays with label, burn rate right-aligned with color coding
    const weekLeftBase = ` 7d    $${fmt(summary.week)}`;
    const burnRatio = summary.cap > 0 ? summary.burnRate / summary.cap : 0;
    let weekRight: string;
    if (burnRatio < 0.9) {
      weekRight = th.fg('success', `burn ~$${fmt(summary.burnRate)}`);
    } else if (burnRatio < 1.5) {
      weekRight = th.fg('warning', `burn ~$${fmt(summary.burnRate)}`);
    } else if (burnRatio < 2.0) {
      weekRight = th.fg('error', `burn ~$${fmt(summary.burnRate)}`);
    } else {
      weekRight = th.bold(th.fg('error', `burn ~$${fmt(summary.burnRate)}`));
    }
    lines.push(rowRightAligned(weekLeftBase, weekRight + '  ', this.width));

    // Today row on its own line
    const todayContent = ` Today $${fmt(summary.today)}`;
    lines.push(rowRightAligned(todayContent, '  ', this.width));
    lines.push(emptyRow(this.width));

    // Top models (7d table)
    if (summary.topModels.length > 0) {
      lines.push(...this.buildModelTableHeader('7d', th));
      lines.push(...this.buildModelTableRows(summary.topModels, '7d'));
      lines.push(emptyRow(this.width));
    }

    // Top models (30d table)
    if (summary.topModels.length > 0) {
      lines.push(...this.buildModelTableHeader('30d', th));
      lines.push(...this.buildModelTableRows(summary.topModels, '30d'));
      lines.push(emptyRow(this.width));
    }

    // By provider (30d table with tokens)
    if (summary.byProvider.length > 0) {
      lines.push(...this.buildProviderTable(summary.byProvider, th));
      lines.push(emptyRow(this.width));
    }

    // Usage by Day (30d bar chart)
    if (summary.byDay && Object.keys(summary.byDay).length > 0) {
      const chartOutput = renderSpendBarChart(summary.byDay, this.width);
      lines.push(row(` Daily spend (30d)`, this.width));
      // Split multi-line chart output and add each line
      for (const chartLine of chartOutput.split('\n')) {
        lines.push(row(chartLine, this.width));
      }
      lines.push(emptyRow(this.width));
    }

    // Last refresh time at the bottom
    if (summary?.timestamp) {
      const refreshDate = new Date(summary.timestamp);
      const timestampStr = refreshDate.toLocaleTimeString();
      lines.push(row(` Last refreshed: ${timestampStr}`, this.width));
      lines.push(emptyRow(this.width));

      // Warning if data is limited due to missing management key
      if (!summary.hasActivityData) {
        lines.push(
          row(
            th.fg('warning', ' Data limited - use management key for model breakdowns'),
            this.width,
          ),
        );
        lines.push(emptyRow(this.width));
      }
    }

    lines.push(boxBottom(this.width));
    lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
    return lines;
  }

  // Formatting utilities

  private fmtCostPerM(spend: number, tokens: number): string {
    if (tokens === 0) return '-';
    return `$${((spend / tokens) * 1_000_000).toFixed(2)}`;
  }

  // Shared table row builder
  private buildTableRow<T>(data: T[], renderRow: (item: T) => string, theme?: Theme): string[] {
    const { COLS } = UsageOverlayComponent;
    const lines: string[] = [];

    if (theme) {
      lines.push(
        row(
          `    ${theme.fg('dim', '-'.repeat(COLS.model))}  ${theme.fg('dim', '-'.repeat(COLS.spend))}  ` +
            `${theme.fg('dim', '-'.repeat(COLS.tokens))}  ${theme.fg('dim', '-'.repeat(COLS.costPerM))}  ` +
            `${theme.fg('dim', '-'.repeat(COLS.reqs))}`,
          this.width,
        ),
      );
    }

    // Data rows
    for (const item of data) {
      lines.push(row(renderRow(item), this.width));
    }

    return lines;
  }

  // Model table header builder
  private buildModelTableHeader(label: '7d' | '30d', theme: Theme): string[] {
    const { COLS } = UsageOverlayComponent;
    const lines: string[] = [];

    lines.push(row(` Top models (${label})`, this.width));
    lines.push(
      row(
        `    ${'Model'.padEnd(COLS.model)}  ${`${label} $`.padStart(COLS.spend)}  ` +
          `${`${label} tok`.padStart(COLS.tokens)}  ${'$/M'.padStart(COLS.costPerM)}  ` +
          `${'reqs'.padStart(COLS.reqs)}`,
        this.width,
      ),
    );
    lines.push(
      row(
        `    ${theme.fg('dim', '-'.repeat(COLS.model))}  ${theme.fg('dim', '-'.repeat(COLS.spend))}  ` +
          `${theme.fg('dim', '-'.repeat(COLS.tokens))}  ${theme.fg('dim', '-'.repeat(COLS.costPerM))}  ` +
          `${theme.fg('dim', '-'.repeat(COLS.reqs))}`,
        this.width,
      ),
    );

    return lines;
  }

  // Model table row builder
  private buildModelTableRows(models: ModelStats[], period: '7d' | '30d'): string[] {
    const { COLS } = UsageOverlayComponent;
    const is7d = period === '7d';

    // Filter to models with spend in this period, sort by spend desc, limit to 4
    const sorted = models
      .filter((m) => (is7d ? m.spend7d > 0 : m.spend30d > 0))
      .sort((a, b) => (is7d ? b.spend7d - a.spend7d : b.spend30d - a.spend30d))
      .slice(0, 4);

    const renderRow = (m: ModelStats) => {
      const spend = is7d ? m.spend7d : m.spend30d;
      const tokens = is7d ? m.tokens7d.total : m.tokens30d.total;
      const reqs = is7d ? m.requests7d : m.requests30d;

      return (
        `    ${truncate(m.name, COLS.model).padEnd(COLS.model)}  ` +
        `${`$${fmt(spend)}`.padStart(COLS.spend)}  ` +
        `${fmtTokens(tokens).padStart(COLS.tokens)}  ` +
        `${this.fmtCostPerM(spend, tokens).padStart(COLS.costPerM)}  ` +
        `${fmtCount(reqs).padStart(COLS.reqs)}`
      );
    };

    return this.buildTableRow(sorted, renderRow);
  }

  // Provider table builder
  private buildProviderTable(providers: ProviderStats[], theme: Theme): string[] {
    const { COLS } = UsageOverlayComponent;
    const lines: string[] = [];

    // Header
    lines.push(row(` By provider (30d)`, this.width));
    lines.push(
      row(
        `    ${'Provider'.padEnd(COLS.model)}  ${'$'.padStart(COLS.spend)}  ` +
          `${'tok'.padStart(COLS.tokens)}  ${'$/M'.padStart(COLS.costPerM)}  ` +
          `${'reqs'.padStart(COLS.reqs)}`,
        this.width,
      ),
    );

    // Data rows - top 4 providers
    const sorted = providers.filter((p) => p.spend > 0).slice(0, 4);

    const renderRow = (p: ProviderStats) => {
      return (
        `    ${truncate(p.name, COLS.model).padEnd(COLS.model)}  ` +
        `${`$${fmt(p.spend)}`.padStart(COLS.spend)}  ` +
        `${fmtTokens(p.tokens.total).padStart(COLS.tokens)}  ` +
        `${this.fmtCostPerM(p.spend, p.tokens.total).padStart(COLS.costPerM)}  ` +
        `${fmtCount(p.requests).padStart(COLS.reqs)}`
      );
    };

    return [...lines, ...this.buildTableRow(sorted, renderRow, theme)];
  }
}

// Helper functions
function boxTop(width: number): string {
  return `┌─${'─'.repeat(width - 4)}─┐`;
}

function boxBottom(width: number): string {
  return `└─${'─'.repeat(width - 4)}─┘`;
}

function emptyRow(width: number): string {
  return `│ ${' '.repeat(width - 4)} │`;
}

// Truncate string to visible width, skipping ANSI escape codes
function truncateToVisibleWidth(str: string, maxVisibleWidth: number): string {
  let visibleSoFar = 0;
  let i = 0;

  while (i < str.length && visibleSoFar < maxVisibleWidth) {
    const char = str[i];

    if (char === '\x1b') {
      // Skip ANSI escape sequence
      // eslint-disable-next-line no-control-regex
      const ansiMatch = str.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (ansiMatch) {
        i += ansiMatch[0].length;
        continue;
      }
    }
    visibleSoFar++;
    i++;
  }
  return str.slice(0, i);
}

function row(content: string, width: number): string {
  const innerWidth = width - 4; // -4 for box borders + padding spaces
  const truncated = truncateToVisibleWidth(content, innerWidth);
  return `│ ${truncated}${' '.repeat(innerWidth - getVisibleWidth(truncated))} │`;
}

function plainRow(content: string, width: number): string {
  const innerWidth = width - 2; // -2 for outer spaces
  const truncated = truncateToVisibleWidth(content, innerWidth);
  return ` ${truncated}${' '.repeat(innerWidth - getVisibleWidth(truncated))} `;
}

// Helper to create a row with left content padded to align right content
function rowRightAligned(leftContent: string, rightContent: string, width: number): string {
  const innerWidth = width - 4; // -4 for box borders + padding spaces
  const rightVisibleWidth = getVisibleWidth(rightContent);

  if (rightVisibleWidth === 0) {
    // No right content - just pad left to full width
    const leftPadded = leftContent.padEnd(innerWidth, ' ');
    return row(leftPadded, width);
  }

  // Account for the space between left and right content
  const remainingWidth = innerWidth - rightVisibleWidth - 1;

  // Get visible version of left content for truncation check
  const leftVisible = getVisibleWidth(leftContent);

  // Pad left content to align right content
  const leftPadded =
    leftVisible > remainingWidth
      ? leftContent.slice(0, remainingWidth - 3) + '...'
      : leftContent.padEnd(remainingWidth, ' ');

  return row(`${leftPadded} ${rightContent}`, width);
}

// Calculate visible width of a string, excluding ANSI escape codes
function getVisibleWidth(str: string): number {
  // Remove ANSI escape codes - handles CSI sequences (ESC [ ... m)
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  const cleanStr = str.replace(ansiRegex, '');
  return cleanStr.length;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

// Truncate string to max length, adding ellipsis if needed
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return str.slice(0, maxLen - 3) + '...';
}
