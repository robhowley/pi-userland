import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { UsageSummary } from './types.js';

const WIDTH = 44;

export class UsageOverlayComponent {
  private lines: string[];
  private theme: Theme;
  private onClose: () => void;

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
    const padding = Math.max(0, Math.floor((width - WIDTH) / 2));
    const pad = ' '.repeat(padding);

    return this.lines.map((line) => truncateToWidth(pad + line, width));
  }

  invalidate(): void {
    // No-op — content is static for this view
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
      lines.push(boxTop('OpenRouter Usage'));
      lines.push(row(th.fg('error', error)));
      if (cachedMinutesAgo !== null) {
        lines.push(row(th.fg('dim', `(last successful fetch: ${cachedMinutesAgo}m ago)`)));
      }
      lines.push(boxBottom());
      lines.push(row(th.fg('dim', 'Press q/ESC/Ctrl+C to close')));
      return lines;
    }

    if (!summary) {
      lines.push('');
      lines.push(boxTop('OpenRouter Usage'));
      lines.push(row(th.fg('dim', 'No usage data available.')));
      lines.push(boxBottom());
      lines.push(row(th.fg('dim', 'Press q/ESC/Ctrl+C to close')));
      return lines;
    }

    // Single view - all information
    lines.push('');
    lines.push(boxTop('OpenRouter Usage'));
    lines.push(emptyRow());

    // Summary section
    // Month row with cap %
    const capStr = summary.cap ? ` / $${fmt(summary.cap)} cap` : '';
    const pctStr = summary.cap ? ` (${Math.round((summary.month / summary.cap) * 100)}%)` : '';
    lines.push(row(`Month $${fmt(summary.month)}${capStr}${pctStr}`));

    // 7d with burn rate
    lines.push(row(`7d    $${fmt(summary.week)}    burn ~$${fmt(summary.burnRate)}`));

    // Today
    lines.push(row(`Today $${fmt(summary.today)}`));
    lines.push(emptyRow());

    // Last refresh time
    if (lastRefreshTime !== null) {
      const refreshMinutesAgo = Math.round((Date.now() - lastRefreshTime) / 60000);
      lines.push(th.fg('dim', row(`Last refreshed: ${refreshMinutesAgo}m ago`)));
      lines.push(emptyRow());
    }

    // Top models (7d)
    if (summary.topModels.length > 0) {
      lines.push(row('Top models (7d)'));
      for (const m of summary.topModels) {
        lines.push(row(`  ${truncate(m.name, 20)} $${fmt(m.spend)}`));
      }
      lines.push(emptyRow());
    }

    // Usage by Provider
    if (summary.byKey && Object.keys(summary.byKey).length > 0) {
      lines.push(row('By provider'));
      const sortedProviders = Object.entries(summary.byKey)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      for (const [provider, spend] of sortedProviders) {
        lines.push(row(`  ${truncate(provider, 24)} $${fmt(spend)}`));
      }
      lines.push(emptyRow());
    }

    // Usage by Day (7d)
    if (summary.byDay && Object.keys(summary.byDay).length > 0) {
      lines.push(row('By day'));
      const sortedDays = Object.entries(summary.byDay)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-7); // Last 7 days
      for (const [day, spend] of sortedDays) {
        lines.push(row(`  ${day} $${fmt(spend)}`));
      }
      lines.push(emptyRow());
    }

    lines.push(boxBottom());
    lines.push(row(th.fg('dim', 'Press q/ESC/Ctrl+C to close')));
    return lines;
  }
}

// Helper functions
function boxTop(title: string): string {
  const content = ` ${title} `;
  const padding = Math.max(0, (WIDTH - 2 - content.length) / 2);
  const leftPad = ' '.repeat(Math.floor(padding));
  const rightPad = ' '.repeat(Math.ceil(padding));
  return `┌${leftPad}${content}${rightPad}┐`;
}

function boxBottom(): string {
  return `└${'─'.repeat(WIDTH - 2)}┘`;
}

function emptyRow(): string {
  return `│${' '.repeat(WIDTH - 2)}│`;
}

function row(content: string): string {
  const truncated = content.length > WIDTH - 2 ? content.slice(0, WIDTH - 2) : content;
  return `│${truncated}${' '.repeat(WIDTH - 2 - truncated.length)}│`;
}

function fmt(value: number): string {
  return value.toFixed(2);
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
