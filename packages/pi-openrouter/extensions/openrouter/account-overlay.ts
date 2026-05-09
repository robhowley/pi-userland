import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent';
import type { KeyInfo, KeyStatus, RollupStatus } from './account-types.js';
import {
  computeRollupStatus,
  formatCurrency,
  formatRemaining,
  sortKeys,
} from './account-format.js';
import { getAllKeys, getCurrentKey, getAccountCredits } from './account-client.js';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';

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
  private error: string | null;
  private selectedIndex: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private requestRender: () => void;
  private isDisposed = false;
  private ctx: ExtensionContext | null = null;

  constructor(
    keyInfo: KeyInfo[] | null,
    credits: number | null,
    rollupStatus: RollupStatus,
    error: string | null,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
    ctx?: ExtensionContext,
  ) {
    this.theme = theme;
    this.onClose = onClose;
    this.requestRender = requestRender;
    this.keyInfo = keyInfo;
    this.credits = credits;
    this.rollupStatus = rollupStatus;
    this.error = error;
    this.selectedIndex = 0;
    this.ctx = ctx || null;
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
      return;
    }

    // Refresh on r
    if (matchesKey(data, 'r')) {
      this.refresh();
      return;
    }

    // Key selection with arrow keys
    if (this.keyInfo && this.keyInfo.length > 0) {
      if (matchesKey(data, 'up')) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.invalidate();
      } else if (matchesKey(data, 'down')) {
        this.selectedIndex = Math.min(this.keyInfo.length - 1, this.selectedIndex + 1);
        this.invalidate();
      }
    }
  }

  wantsKeyRelease = false;

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
    // Clamp selected index if key list shrunk after re-sort
    if (this.keyInfo && this.selectedIndex >= this.keyInfo.length) {
      this.selectedIndex = this.keyInfo.length - 1;
    }
    if (!this.isDisposed) {
      this.requestRender();
    }
  }

  async refresh(): Promise<void> {
    if (this.isDisposed || !this.ctx) return;

    try {
      const allKeys = await getAllKeys();
      let credits: number | null = null;
      try {
        credits = await getAccountCredits();
      } catch {
        // Silently ignore credit fetch errors
      }

      let error: string | null = null;
      let keyInfo: KeyInfo[] | null = null;

      if (allKeys && allKeys.length > 0) {
        keyInfo = allKeys;
      } else {
        error = 'Key list unavailable - set OPENROUTER_MANAGEMENT_KEY for full key inventory.';
        try {
          const currentKey = await getCurrentKey();
          if (currentKey) {
            keyInfo = [currentKey];
          }
        } catch {
          // Ignore secondary errors
        }
      }

      const rollupStatus = keyInfo
        ? computeRollupStatus(keyInfo)
        : { status: 'unavailable' as const };

      // Update state
      this.keyInfo = keyInfo;
      this.credits = credits;
      this.rollupStatus = rollupStatus;
      this.error = error;

      // Reset selection and rebuild
      this.selectedIndex = 0;
      this.width = this.calculateWidth();
      this.lines = this.buildLines();

      this.requestRender();
    } catch {
      // Silently ignore refresh errors
    }
  }

  private calculateWidth(): number {
    return Math.max(MIN_WIDTH, this.keyInfo && this.keyInfo.length > 0 ? 55 : 50);
  }

  /** Get the header row for the account overlay */
  private getAccountHeaderRow(): string {
    return row(
      this.theme.fg('accent', this.theme.bold(' ◈ OpenRouter Account  ·  /openrouter account')),
      this.width,
    );
  }

  private buildLines(): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if (this.error) {
      lines.push(boxTop(this.width));
      lines.push(this.getAccountHeaderRow());
      lines.push(emptyRow(this.width));
      lines.push(row(th.fg('error', this.error), this.width));
      lines.push(boxBottom(this.width));
      lines.push(plainRow(th.fg('dim', 'Esc to close'), this.width));
      return lines;
    }

    lines.push(boxTop(this.width));
    lines.push(this.getAccountHeaderRow());
    lines.push(emptyRow(this.width));

    // Total spend line (sum of all key spends)
    if (this.keyInfo && this.keyInfo.length > 0) {
      const totalSpend = this.keyInfo.reduce((sum, k) => sum + k.spend, 0);
      lines.push(row(` usage      ${formatCurrency(totalSpend)}`, this.width));
    }

    // Credits line
    if (this.credits !== null) {
      lines.push(row(` credits    ${formatCurrency(this.credits)}`, this.width));
    } else {
      lines.push(row(th.fg('dim', ' credits          unavailable'), this.width));
    }

    // Status by key line
    lines.push(row(` status     ${this.rollupStatus.message}`, this.width));
    lines.push(emptyRow(this.width));

    if (this.keyInfo && this.keyInfo.length > 0) {
      // Sort keys - active first, then spend desc, then usage % desc
      const sortedKeys = sortKeys(this.keyInfo);

      // Current key section - show for selected key
      // Defensive: ensure index is within bounds before accessing
      const index = Math.max(0, Math.min(this.selectedIndex, sortedKeys.length - 1));
      const currentKey = sortedKeys[index];
      if (currentKey) {
        lines.push(row(` ${th.fg('accent', 'Selected key')}`, this.width));
        lines.push(...this.buildKeyDetails(currentKey, th));
        lines.push(emptyRow(this.width));
      }

      // All keys section - show all keys in compact format (including current key)
      lines.push(row(` ${th.fg('accent', 'All keys')}`, this.width));
      lines.push(row(`   Workspace    Key name           Active   Spend    Used   `, this.width));
      for (let i = 0; i < sortedKeys.length; i++) {
        lines.push(this.buildCompactKeyRow(sortedKeys[i]!, th, i === this.selectedIndex));
      }
      lines.push(emptyRow(this.width));
    } else {
      // No keys available
      lines.push(row(th.fg('dim', ' No keys available'), this.width));
    }
    lines.push(boxBottom(this.width));
    lines.push(
      plainRow(th.fg('dim', 'Esc to close  ·  r to refresh  ·  ↑/↓ to select'), this.width),
    );
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

    // Format reset cadence
    const resetText = key.resetCadence || 'never';

    lines.push(row(`  name      ${truncate(key.name, 30)}`, this.width));
    lines.push(row(`  key       ${truncate(key.label, 30)}`, this.width));
    lines.push(row(`  status    ${formattedStatus}`, this.width));
    lines.push(row(`  used      ${usedLimitText}`, this.width));
    lines.push(row(`  reset     ${resetText}`, this.width));
    lines.push(row(`  byok      ${key.byok}`, this.width));

    return lines;
  }

  private simplifiedWorkspaceName(workspaceName: string): string {
    return workspaceName.replace(/Workspace$/, '').trim();
  }

  private buildCompactKeyRow(key: KeyInfo, theme: Theme, isSelected: boolean): string {
    // Format spend
    let spendText: string;
    if (key.disabled) {
      spendText = '-';
    } else {
      spendText = formatCurrency(key.spend);
    }

    // Color spend based on value
    let spendColor: ThemeColor = 'success';
    if (key.disabled) {
      spendColor = 'dim';
    } else if (key.spend >= 100) {
      spendColor = 'error';
    } else if (key.spend >= 50) {
      spendColor = 'warning';
    }

    // Pad spend to 8 chars for alignment based on visible width
    const paddedSpend = padToWidth(theme.fg(spendColor as ThemeColor, spendText), 8);

    // Calculate usage percentage
    let usageText: string;
    if (key.disabled) {
      usageText = '-';
    } else if (key.limit === 0) {
      usageText = '∞';
    } else if (key.limit === undefined) {
      usageText = '-';
    } else if (key.used !== undefined && key.limit !== undefined) {
      const percent = Math.round((key.used / key.limit) * 100);
      usageText = `${percent}%`;
    } else {
      usageText = '-';
    }

    // Color usage based on percentage
    let usageColor: ThemeColor = 'success';
    if (key.disabled) {
      usageColor = 'dim';
    } else if (usageText === '∞') {
      usageColor = 'error';
    } else {
      const percent = parseInt(usageText, 10);
      if (percent >= 90) {
        usageColor = 'error';
      } else if (percent >= 70) {
        usageColor = 'warning';
      } else {
        usageColor = 'success';
      }
    }

    // Pad usage to 6 chars for alignment based on visible width
    const paddedUsage = padToWidth(theme.fg(usageColor as ThemeColor, usageText), 5);

    const enabledIcon = key.disabled
      ? this.theme.fg('error' as ThemeColor, '\u2717')
      : this.theme.fg('success' as ThemeColor, '\u2713');

    // Truncate name and workspace for compact display
    const name = truncate(key.name, 28);
    const workspace = truncate(this.simplifiedWorkspaceName(key.workspaceName), 20);

    // Selection indicator
    const selectionIndicator = isSelected ? '●' : '○';

    return row(
      ` ${selectionIndicator} ${workspace.padEnd(11)}  ${name.padEnd(21)} ${enabledIcon}     ${paddedSpend}  ${paddedUsage}`,
      this.width,
    );
  }

  private getStatusColor(status: KeyStatus): ThemeColor {
    switch (status) {
      case 'danger':
        return 'error';
      case 'caution':
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

// Pad string to fixed width, accounting for ANSI escape codes
function padToWidth(str: string, width: number): string {
  const visibleWidth = getVisibleWidth(str);
  const paddingNeeded = width - visibleWidth;
  if (paddingNeeded <= 0) return str;
  return str + ' '.repeat(paddingNeeded);
}
