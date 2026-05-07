import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent';
import type { KeyInfo, KeyStatus, RollupStatus } from './account-types.js';
import { formatCurrency, formatLeft, formatRemaining, sortKeys } from './account-format.js';

// =============================================================================
// Constants
// =============================================================================

const MIN_WIDTH = 65;

// =============================================================================
// Account Overlay Component
// =============================================================================

export class AccountOverlayComponent {
  private lines: string[];
  private theme: Theme;
  private onClose: () => void;
  private width: number;
  private keyInfo: KeyInfo[] | null;
  private credits: number | null;
  private rollupStatus: RollupStatus;
  private currentHash: string | undefined;
  private error: string | null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private requestRender: () => void;
  private isDisposed = false;

  constructor(
    keyInfo: KeyInfo[] | null,
    credits: number | null,
    rollupStatus: RollupStatus,
    currentHash: string | undefined,
    error: string | null,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
  ) {
    this.theme = theme;
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.keyInfo = keyInfo;
    this.credits = credits;
    this.rollupStatus = rollupStatus;
    this.currentHash = currentHash;
    this.error = error;
    this.width = this.calculateWidth();
    this.lines = this.buildLines();

    // Set up timer to rebuild lines every 30 seconds
    this.refreshTimer = setInterval(() => {
      this.invalidate();
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
    const padding = Math.max(0, Math.floor((width - this.width) / 2));
    const pad = ' '.repeat(padding);

    return this.lines.map((line) => truncateToWidth(pad + line, width));
  }

  invalidate(): void {
    if (this.isDisposed) return;
    // Rebuild lines to update "last refreshed" time
    this.lines = this.buildLines();
    if (!this.isDisposed) {
      this.requestRender();
    }
  }

  private calculateWidth(): number {
    return Math.max(MIN_WIDTH, this.keyInfo && this.keyInfo.length > 0 ? 55 : 50);
  }

  private buildLines(): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if (this.error) {
      lines.push(boxTop(this.width));
      lines.push(
        row(th.fg('accent', th.bold(' ◈ OpenRouter Account  ·  /openrouter-account')), this.width),
      );
      lines.push(emptyRow(this.width));
      lines.push(row(th.fg('error', this.error), this.width));
      lines.push(boxBottom(this.width));
      lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
      return lines;
    }

    lines.push(boxTop(this.width));
    lines.push(
      row(th.fg('accent', th.bold(' ◈ OpenRouter Account  ·  /openrouter-account')), this.width),
    );
    lines.push(emptyRow(this.width));

    // Credits line
    if (this.credits !== null) {
      lines.push(row(` credits   ${formatCurrency(this.credits)}`, this.width));
    } else {
      lines.push(row(th.fg('dim', ' credits   unavailable'), this.width));
    }

    // Status line
    const statusLine = this.formatRollupStatus(this.rollupStatus);
    lines.push(row(` status    ${statusLine}`, this.width));
    lines.push(emptyRow(this.width));

    if (this.keyInfo && this.keyInfo.length > 0) {
      // Sort keys - current key first (though hash matching is v1 follow-up)
      const sortedKeys = sortKeys(this.keyInfo, this.currentHash);

      // Current key section - show for first key (v1: no hash matching yet)
      const currentKey = sortedKeys[0]!; // Non-null assertion - array is not empty
      lines.push(row(` ${th.fg('accent', 'Current key')}`, this.width));
      lines.push(...this.buildKeyDetails(currentKey, th));
      lines.push(emptyRow(this.width));

      // All keys section - show all keys in compact format (including current key)
      lines.push(emptyRow(this.width));
      lines.push(row(` ${th.fg('accent', 'All keys')}`, this.width));
      for (const key of sortedKeys) {
        lines.push(this.buildCompactKeyRow(key, th));
      }
      lines.push(emptyRow(this.width));
    } else {
      // No keys available
      lines.push(row(th.fg('dim', ' No keys available'), this.width));
    }
    lines.push(boxBottom(this.width));
    lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
    return lines;
  }

  private buildKeyDetails(key: KeyInfo, theme: Theme): string[] {
    const lines: string[] = [];

    // Format status with color
    const statusColor = this.getStatusColor(key.status);
    const statusText = key.status;
    const formattedStatus = theme.fg(statusColor as ThemeColor, statusText);

    // Format used/limit
    const usedLimitText = formatRemaining(key.used, key.limit);

    // Format left
    const leftText = formatLeft(key.remaining);

    // Format reset cadence
    const resetText = key.resetCadence || 'never';

    // Format BYOK
    const byokText = key.byok || 'unknown';

    // Add current session marker
    const keyLabel = key.hash === this.currentHash ? `● ${key.label}` : key.label;

    lines.push(row(`  name     ${truncate(key.name, 30)}`, this.width));
    lines.push(row(`  key      ${truncate(keyLabel, 30)}`, this.width));
    lines.push(row(`  status   ${formattedStatus}`, this.width));
    lines.push(row(`  used     ${usedLimitText}`, this.width));
    lines.push(
      row(
        `  limit    ${key.limit === undefined ? 'unlimited' : formatCurrency(key.limit)}`,
        this.width,
      ),
    );
    lines.push(row(`  left     ${leftText}`, this.width));
    lines.push(row(`  reset    ${resetText}`, this.width));
    lines.push(row(`  BYOK     ${byokText}`, this.width));

    return lines;
  }

  private buildCompactKeyRow(key: KeyInfo, theme: Theme): string {
    // Format status with color
    const statusColor = this.getStatusColor(key.status);
    const statusText = key.status;
    const formattedStatus = theme.fg(statusColor as ThemeColor, statusText);

    // Format BYOK
    const byokText = key.byok || 'unknown';

    // Truncate name and workspace for compact display
    const name = truncate(key.name, 18);
    const workspace = truncate(key.workspaceName, 20);

    return row(
      `    ${workspace.padEnd(20)}  ${name.padEnd(18)}  ${formattedStatus.padEnd(10)}  ${byokText.padEnd(6)}`,
      this.width,
    );
  }

  private getStatusColor(status: KeyStatus): ThemeColor {
    switch (status) {
      case 'danger':
        return 'error';
      case 'caution':
        return 'warning';
      case 'watch':
        return 'warning';
      case 'disabled':
        return 'error';
      case 'partial':
        return 'warning';
      case 'unbounded':
        return 'success';
      default:
        return 'success';
    }
  }

  private formatRollupStatus(status: RollupStatus): string {
    switch (status.status) {
      case 'unavailable':
        return 'unavailable';
      case 'healthy':
        return this.theme.fg('success' as ThemeColor, status.message);
      case 'watch':
        return this.theme.fg('warning' as ThemeColor, status.message);
      case 'caution':
        return this.theme.fg('warning' as ThemeColor, status.message);
      case 'danger':
        return this.theme.fg('error' as ThemeColor, status.message);
      case 'disabled':
        return this.theme.fg('error' as ThemeColor, status.message);
    }
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function boxTop(width: number): string {
  return `┌─${'─'.repeat(width - 4)}─┐`;
}

function boxBottom(width: number): string {
  return `└─${'─'.repeat(width - 4)}─┘`;
}

function emptyRow(width: number): string {
  return `│ ${' '.repeat(width - 4)} │`;
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

// Calculate visible width of a string, excluding ANSI escape codes
function getVisibleWidth(str: string): number {
  // Remove ANSI escape codes
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*m/g;
  const cleanStr = str.replace(ansiRegex, '');
  return cleanStr.length;
}

// Truncate string to max length, adding ellipsis if needed
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return str.slice(0, maxLen - 3) + '...';
}
