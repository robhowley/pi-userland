import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';
import { usageCache } from './cache.js';

const MIN_WIDTH = 44;
const MAX_WIDTH = 80;

export class UsageOverlayComponent {
  private lines: string[];
  private theme: Theme;
  private onClose: () => void;
  private width: number;
  private summary: UsageSummary | null;
  private subcommand: string | undefined;
  private error: string | null;
  private cachedMinutesAgo: number | null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private requestRender: () => void;

  constructor(
    summary: UsageSummary | null,
    subcommand: string | undefined,
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
    this.subcommand = subcommand;
    this.error = error;
    this.cachedMinutesAgo = cachedMinutesAgo;
    this.width = this.calculateWidth(summary);
    this.lines = this.buildLines(summary, subcommand, error, cachedMinutesAgo);

    // Set up timer to rebuild lines every 30 seconds to update "last refreshed" time
    this.refreshTimer = setInterval(() => {
      this.invalidate();
      // Force re-render by calling requestRender on the TUI
      // We need to store a reference to requestRender to do this
    }, 30000);
  }

  dispose(): void {
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
    const padding = Math.max(0, Math.floor((width - this.width) / 2));
    const pad = ' '.repeat(padding);

    return this.lines.map((line) => truncateToWidth(pad + line, width));
  }

  invalidate(): void {
    // Rebuild lines to update "last refreshed" time from fresh cached data
    const freshSummary = usageCache.get('usage');
    this.lines = this.buildLines(freshSummary || this.summary, this.subcommand, this.error, this.cachedMinutesAgo);
    this.requestRender();
  }

  private calculateWidth(summary: UsageSummary | null): number {
    if (!summary) return MIN_WIDTH;

    let maxWidth = MIN_WIDTH;

    // Calculate width needed for top models table
    if (summary.topModels7d.length > 0 || summary.topModels30d.length > 0) {
      const allModelNames = [
        ...summary.topModels7d.map(m => m.name),
        ...summary.topModels30d.map(m => m.name),
      ];
      const maxModelNameLen = allModelNames.reduce((max, name) => Math.max(max, name.length), 0);
      const amountWidth = 8; // "$X.XX" + padding
      const rowWidth = 2 + maxModelNameLen + 2 + amountWidth + 2 + amountWidth + 2;
      maxWidth = Math.max(maxWidth, rowWidth);
    }

    // Calculate width needed for provider table
    if (summary.byKey && Object.keys(summary.byKey).length > 0) {
      const maxProviderLen = Object.keys(summary.byKey).reduce(
        (max, name) => Math.max(max, name.length),
        0,
      );
      const amountWidth = 8;
      const rowWidth = 2 + maxProviderLen + 2 + amountWidth + 2;
      maxWidth = Math.max(maxWidth, rowWidth);
    }

    // Calculate width needed for by-day table
    if (summary.byDay && Object.keys(summary.byDay).length > 0) {
      maxWidth = Math.max(maxWidth, 21);
    }

    // Ensure we have room for main stats
    // "Month $X.XX / $X.XX cap (XX%)" - max ~35 chars
    // "burn ~$X.XX" = 13 chars + space + "Today $X.XX" = 11
    // Need: 35 + 1 + 13 + 2 (borders) = 51, or 35 + 1 + 11 + 2 = 49
    // Use 46 as it fits both cases with proper padding
    maxWidth = Math.max(maxWidth, 46);

    return Math.min(maxWidth, MAX_WIDTH);
  }

  private buildLines(
    summary: UsageSummary | null,
    _subcommand: string | undefined,
    error: string | null,
    cachedMinutesAgo: number | null,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if (error) {
      lines.push(boxTop(this.width));
      lines.push(row('OpenRouter Usage', this.width));
      lines.push(emptyRow(this.width));
      lines.push(row(th.fg('error', error), this.width));
      if (cachedMinutesAgo !== null) {
        lines.push(row(th.fg('dim', `(last successful fetch: ${cachedMinutesAgo}m ago)`), this.width));
      }
      lines.push(boxBottom(this.width));
      lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
      return lines;
    }

    if (!summary) {
      lines.push(boxTop(this.width));
      lines.push(row('OpenRouter Usage', this.width));
      lines.push(emptyRow(this.width));
      lines.push(row(th.fg('dim', 'No usage data available.'), this.width));
      lines.push(boxBottom(this.width));
      lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
      return lines;
    }

    // Summary view (subcommand views TODO)
    lines.push(boxTop(this.width));
    lines.push(row('OpenRouter Usage', this.width));
    lines.push(emptyRow(this.width));

    // Month row: amount stays with label, cap percentage right-aligned
    const monthLeftBase = `Month $${fmt(summary.month)} / $${fmt(summary.cap)}`;
    const monthRight = `cap (${Math.round((summary.month / summary.cap) * 100)}%)`;
    lines.push(rowRightAligned(monthLeftBase, monthRight, this.width));

    // 7d row: amount stays with label, burn rate right-aligned
    const weekLeftBase = `7d    $${fmt(summary.week)}`;
    const weekRight = `burn ~$${fmt(summary.burnRate)}`;
    lines.push(rowRightAligned(weekLeftBase, weekRight, this.width));

    // Today row on its own line
    const todayContent = `Today $${fmt(summary.today)}`;
    lines.push(rowRightAligned(todayContent, '', this.width));
    lines.push(emptyRow(this.width));

    // Top models - 7d and 30d as columns
    if (summary.topModels7d.length > 0 || summary.topModels30d.length > 0) {
      // Calculate column widths
      const allModelNames = [
        ...summary.topModels7d.map(m => m.name),
        ...summary.topModels30d.map(m => m.name),
      ];
      const maxModelNameLen = allModelNames.reduce((max, name) => Math.max(max, name.length), 0);
      const headerModelWidth = Math.max(7, maxModelNameLen);
      const amountWidth = 8; // "$X.XX" + padding
      
      lines.push(row('Top models', this.width));
      lines.push(row(`  Model${' '.repeat(headerModelWidth - 5)}  ${'7d'.padStart(amountWidth)}  ${'30d'.padStart(amountWidth)}`, this.width));
      lines.push(row(`  ${'-'.repeat(headerModelWidth)}  ${'-'.repeat(amountWidth)}  ${'-'.repeat(amountWidth)}`, this.width));

      // Build spend map from 7d data
      const spendMap = new Map<string, { spend7d: number; spend30d: number }>();
      for (const m of summary.topModels7d) {
        spendMap.set(m.name, { spend7d: m.spend, spend30d: 0 });
      }
      // Add/update with 30d data
      for (const m of summary.topModels30d) {
        const existing = spendMap.get(m.name);
        spendMap.set(m.name, {
          spend7d: existing?.spend7d ?? 0,
          spend30d: m.spend,
        });
      }

      // Sort by 30d spend (primary), then 7d (secondary)
      const sortedModels = Array.from(spendMap.entries())
        .sort((a, b) => b[1].spend30d - a[1].spend30d || b[1].spend7d - a[1].spend7d)
        .slice(0, 6); // Show top 6 models

      for (const [name, spends] of sortedModels) {
        const spend7dStr = spends.spend7d > 0 ? `$${fmt(spends.spend7d)}` : '-';
        const spend30dStr = spends.spend30d > 0 ? `$${fmt(spends.spend30d)}` : '-';
        const modelLabel = name; // Don't truncate - let the row function handle it
        lines.push(row(`  ${modelLabel}${' '.repeat(headerModelWidth - name.length)}  ${spend7dStr.padStart(amountWidth)}  ${spend30dStr.padStart(amountWidth)}`, this.width));
      }
      lines.push(emptyRow(this.width));
    }

    // Usage by Provider
    if (summary.byKey && Object.keys(summary.byKey).length > 0) {
      const sortedProviders = Object.entries(summary.byKey)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      const maxProviderLen = sortedProviders.reduce(
        (max, [name]) => Math.max(max, name.length),
        0,
      );
      
      lines.push(row('By provider', this.width));
      lines.push(row(`  Provider${' '.repeat(maxProviderLen - 8)}  30d`, this.width));
      lines.push(row(`  ${'-'.repeat(maxProviderLen)}  ------`, this.width));
      
      for (const [provider, spend] of sortedProviders) {
        lines.push(row(`  ${provider}${' '.repeat(maxProviderLen - provider.length)}  $${fmt(spend)}`, this.width));
      }
      lines.push(emptyRow(this.width));
    }

    // Usage by Day (7d)
    if (summary.byDay && Object.keys(summary.byDay).length > 0) {
      const sortedDays = Object.entries(summary.byDay)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-7); // Last 7 days
      const maxDateLen = sortedDays.reduce(
        (max, [date]) => Math.max(max, date.length),
        0,
      );
      
      lines.push(row('By day', this.width));
      lines.push(row(`  Date${' '.repeat(maxDateLen - 4)}  Amount`, this.width));
      lines.push(row(`  ${'-'.repeat(maxDateLen)}  ------`, this.width));
      
      for (const [day, spend] of sortedDays) {
        lines.push(row(`  ${day}${' '.repeat(maxDateLen - day.length)}  $${fmt(spend)}`, this.width));
      }
      lines.push(emptyRow(this.width));
    }

    // Last refresh time at the bottom
    if (summary?.timestamp) {
      const refreshDate = new Date(summary.timestamp);
      const timestampStr = refreshDate.toLocaleTimeString();
      lines.push(row(`Last refreshed: ${timestampStr}`, this.width));
      lines.push(emptyRow(this.width));
    }

    lines.push(boxBottom(this.width));
    lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
    return lines;
  }
}

// Helper functions
function boxTop(width: number): string {
  return `┌${'─'.repeat(width - 2)}┐`;
}

function boxBottom(width: number): string {
  return `└${'─'.repeat(width - 2)}┘`;
}

function emptyRow(width: number): string {
  return `│${' '.repeat(width - 2)}│`;
}

function row(content: string, width: number): string {
  const truncated = content.length > width - 2 ? content.slice(0, width - 2) : content;
  return `│${truncated}${' '.repeat(width - 2 - truncated.length)}│`;
}

function plainRow(content: string, width: number): string {
  const truncated = content.length > width - 2 ? content.slice(0, width - 2) : content;
  return ` ${truncated}${' '.repeat(width - 1 - truncated.length)} `;
}

// Helper to create a row with left content padded to align right content
function rowRightAligned(leftContent: string, rightContent: string, width: number): string {
  const boxInnerWidth = width - 2; // -2 for box borders
  const rightWidth = rightContent.length;
  
  if (rightWidth === 0) {
    // No right content - just pad left to full width
    const leftPadded = leftContent.padEnd(boxInnerWidth, ' ');
    return row(leftPadded, width);
  }
  
  // Account for the space between left and right content
  const remainingWidth = boxInnerWidth - rightWidth - 1;
  
  // Pad left content to align right content
  const leftPadded = leftContent.length > remainingWidth
    ? leftContent.slice(0, remainingWidth - 3) + '...'
    : leftContent.padEnd(remainingWidth, ' ');
  
  return row(`${leftPadded} ${rightContent}`, width);
}

function fmt(value: number): string {
  return value.toFixed(2);
}
