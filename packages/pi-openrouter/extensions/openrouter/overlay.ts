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
    theme: Theme,
    onClose: () => void,
  ) {
    this.theme = theme;
    this.onClose = onClose;
    this.lines = this.buildLines(summary, subcommand, error, cachedMinutesAgo);
  }

  handleInput(data: string): void {
    // Close on q, escape, or any key per spec
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
    } else {
      // Any other key also closes (per spec: "any keypress")
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
      lines.push(row(th.fg('dim', 'Press any key to close')));
      return lines;
    }

    if (!summary) {
      lines.push('');
      lines.push(boxTop('OpenRouter Usage'));
      lines.push(row(th.fg('dim', 'No usage data available.')));
      lines.push(boxBottom());
      lines.push(row(th.fg('dim', 'Press any key to close')));
      return lines;
    }

    // Summary view (default)
    if (!subcommand) {
      lines.push('');
      lines.push(boxTop('OpenRouter Usage'));
      lines.push(emptyRow());

      // Month row with cap %
      const capStr = summary.cap ? ` / $${fmt(summary.cap)} cap` : '';
      const pctStr = summary.cap ? ` (${Math.round((summary.month / summary.cap) * 100)}%)` : '';
      lines.push(row(`Month $${fmt(summary.month)}${capStr}${pctStr}`));

      // 7d with burn rate
      lines.push(row(`7d    $${fmt(summary.week)}    burn ~$${fmt(summary.burnRate)}`));

      // Today
      lines.push(row(`Today $${fmt(summary.today)}`));
      lines.push(emptyRow());

      // Top models
      if (summary.topModels.length > 0) {
        lines.push(row('Top models (7d)'));
        for (const m of summary.topModels) {
          lines.push(row(`  ${truncate(m.name, 20)} $${fmt(m.spend)}`));
        }
        lines.push(emptyRow());
      }

      // Cache rate
      if (summary.cacheRate !== undefined) {
        lines.push(row(`Cache rate: ${Math.round(summary.cacheRate * 100)}%`));
        lines.push(emptyRow());
      }

      lines.push(boxBottom());
      lines.push(row(th.fg('dim', 'Press any key to close')));

      return lines;
    }

    // Subcommand views
    if (subcommand === 'models' && summary.byModel) {
      lines.push('');
      lines.push(boxTop('Usage by Model'));
      const sorted = Object.entries(summary.byModel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [name, spend] of sorted) {
        lines.push(row(`${truncate(name, 28)} $${fmt(spend)}`));
      }
      lines.push(boxBottom());
    } else if (subcommand === 'keys' && summary.byKey) {
      lines.push('');
      lines.push(boxTop('Usage by Key'));
      const sorted = Object.entries(summary.byKey).sort((a, b) => b[1] - a[1]);
      for (const [hash, spend] of sorted) {
        lines.push(row(`${truncate(hash, 28)} $${fmt(spend)}`));
      }
      lines.push(boxBottom());
    } else if (subcommand === '7d' && summary.byDay) {
      lines.push('');
      lines.push(boxTop('Usage by Day'));
      const sorted = Object.entries(summary.byDay).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [day, spend] of sorted) {
        lines.push(row(`${day} $${fmt(spend)}`));
      }
      lines.push(boxBottom());
    } else {
      // Fallback for unknown subcommand or missing data
      lines.push('');
      lines.push(boxTop('OpenRouter Usage'));
      lines.push(row(th.fg('dim', 'No data available for this view.')));
      lines.push(boxBottom());
    }

    lines.push(row(th.fg('dim', 'Press any key to close')));
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
