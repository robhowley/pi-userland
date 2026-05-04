import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';

const MIN_WIDTH = 44;
const MAX_WIDTH = 80;

export class UsageOverlayComponent {
  private lines: string[];
  private theme: Theme;
  private onClose: () => void;
  private width: number;

  constructor(
    summary: UsageSummary | null,
    subcommand: string | undefined,
    error: string | null,
    cachedMinutesAgo: number | null,
    lastRefreshTime: number | null,
    theme: Theme,
    onClose: () => void,
  ) {
    this.theme = theme;
    this.onClose = onClose;
    this.width = this.calculateWidth(summary);
    this.lines = this.buildLines(summary, subcommand, error, cachedMinutesAgo, lastRefreshTime);
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
    // No-op — content is static for this view
  }

  private calculateWidth(summary: UsageSummary | null): number {
    if (!summary) return MIN_WIDTH;

    let maxWidth = MIN_WIDTH;

    // Calculate width needed for top models table
    if (summary.topModels7d.length > 0 || summary.topModels30d.length > 0) {
      // Header: "Top models" (10 chars) + "  Model              7d      30d"
      // Row: "  model-name            $X.XX   $X.XX"
      // Max model name length + 30 chars for the rest (2 + 18 + 2 + 7 + 2 + 7 + 2)
      const allModelNames = [
        ...summary.topModels7d.map(m => m.name),
        ...summary.topModels30d.map(m => m.name),
      ];
      const maxModelNameLen = allModelNames.reduce((max, name) => Math.max(max, name.length), 0);
      const rowWidth = 2 + maxModelNameLen + 2 + 7 + 2 + 7 + 2; // "  model  $X.XX  $X.XX"
      maxWidth = Math.max(maxWidth, rowWidth);
    }

    // Calculate width needed for provider table
    if (summary.byKey && Object.keys(summary.byKey).length > 0) {
      const maxProviderLen = Object.keys(summary.byKey).reduce(
        (max, name) => Math.max(max, name.length),
        0,
      );
      // "  provider-name       $X.XX" = 2 + name + 2 + 7 + 2
      const rowWidth = 2 + maxProviderLen + 2 + 7 + 2;
      maxWidth = Math.max(maxWidth, rowWidth);
    }

    // Calculate width needed for by-day table
    if (summary.byDay && Object.keys(summary.byDay).length > 0) {
      // "  2026-04-29 $5.12" = 2 + 10 + 1 + 5 = 18 minimum
      // But we want room for dates and amounts
      maxWidth = Math.max(maxWidth, 30);
    }

    // Ensure we have room for main stats
    // "Month $X.XX / $X.XX cap (XX%)" - max cap is 6 digits + 2 decimals = 8 chars
    // So row is about 30-35 chars
    maxWidth = Math.max(maxWidth, 40);

    return Math.min(maxWidth, MAX_WIDTH);
  }

  private buildLines(
    summary: UsageSummary | null,
    subcommand: string | undefined,
    error: string | null,
    cachedMinutesAgo: number | null,
    lastRefreshTime: number | null,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if (error) {
      lines.push('');
      lines.push(boxTop('OpenRouter Usage', this.width));
      lines.push(row(th.fg('error', error), this.width));
      if (cachedMinutesAgo !== null) {
        lines.push(row(th.fg('dim', `(last successful fetch: ${cachedMinutesAgo}m ago)`), this.width));
      }
      lines.push(boxBottom(this.width));
      lines.push(row(th.fg('dim', 'Press q/ESC/Ctrl+C to close'), this.width));
      return lines;
    }

    if (!summary) {
      lines.push('');
      lines.push(boxTop('OpenRouter Usage', this.width));
      lines.push(row(th.fg('dim', 'No usage data available.'), this.width));
      lines.push(boxBottom(this.width));
      lines.push(row(th.fg('dim', 'Press q/ESC/Ctrl+C to close'), this.width));
      return lines;
    }

    // Single view - all information
    lines.push('');
    lines.push(boxTop('OpenRouter Usage', this.width));
    lines.push(emptyRow(this.width));

    // Month row with cap %
    const capStr = summary.cap ? ` / $${fmt(summary.cap)} cap` : '';
    const pctStr = summary.cap ? ` (${Math.round((summary.month / summary.cap) * 100)}%)` : '';
    lines.push(row(`Month $${fmt(summary.month)}${capStr}${pctStr}`, this.width));

    // 7d with burn rate
    lines.push(row(`7d    $${fmt(summary.week)}    burn ~$${fmt(summary.burnRate)}`, this.width));

    // Today
    lines.push(row(`Today $${fmt(summary.today)}`, this.width));
    lines.push(emptyRow(this.width));

    // Last refresh time
    if (lastRefreshTime !== null) {
      const refreshMinutesAgo = Math.round((Date.now() - lastRefreshTime) / 60000);
      lines.push(th.fg('dim', row(`Last refreshed: ${refreshMinutesAgo}m ago`, this.width)));
      lines.push(emptyRow(this.width));
    }

    // Top models - 7d and 30d as columns
    if (summary.topModels7d.length > 0 || summary.topModels30d.length > 0) {
      // Calculate header and separator widths based on data
      const allModelNames = [
        ...summary.topModels7d.map(m => m.name),
        ...summary.topModels30d.map(m => m.name),
      ];
      const maxModelNameLen = allModelNames.reduce((max, name) => Math.max(max, name.length), 0);
      const headerModelWidth = Math.max(7, maxModelNameLen);
      const separator = ' '.repeat(headerModelWidth);
      
      lines.push(row('Top models', this.width));
      lines.push(row(`  Model${' '.repeat(headerModelWidth - 5)}  7d      30d`, this.width));
      lines.push(row(`  ${separator}  -------  -------`, this.width));

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
        lines.push(row(`  ${modelLabel}  ${spend7dStr}  ${spend30dStr}`, this.width));
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
      lines.push(row(`  Provider${' '.repeat(maxProviderLen - 8)}  Amount`, this.width));
      lines.push(row(`  ${' '.repeat(maxProviderLen)}  ------`, this.width));
      
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
      lines.push(row(`  ${' '.repeat(maxDateLen)}  ------`, this.width));
      
      for (const [day, spend] of sortedDays) {
        lines.push(row(`  ${day}${' '.repeat(maxDateLen - day.length)}  $${fmt(spend)}`, this.width));
      }
      lines.push(emptyRow(this.width));
    }

    lines.push(boxBottom());
    lines.push(row(th.fg('dim', 'Press q/ESC/Ctrl+C to close')));
    return lines;
  }
}

// Helper functions
function boxTop(title: string, width: number): string {
  const content = ` ${title} `;
  const padding = Math.max(0, (width - 2 - content.length) / 2);
  const leftPad = ' '.repeat(Math.floor(padding));
  const rightPad = ' '.repeat(Math.ceil(padding));
  return `┌${leftPad}${content}${rightPad}┐`;
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

function fmt(value: number): string {
  return value.toFixed(2);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
