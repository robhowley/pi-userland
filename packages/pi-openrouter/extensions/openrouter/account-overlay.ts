import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { ExtensionContext, Theme, ThemeColor } from '@mariozechner/pi-coding-agent';
import type { KeyInfo, KeyStatus, RollupStatus } from './account-types.js';
import {
  computeRollupStatus,
  formatCurrency,
  formatRemaining,
  sortKeys,
} from './account-format.js';
import {
  getAccountCredits,
  getAllKeys,
  getCurrentKey,
  setApiKeyDisabled,
} from './account-client.js';

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
  private confirmationHash: string | null = null;
  private pendingToggleHash: string | null = null;
  private inlineMessage: string | null = null;
  private inlineMessageTone: ThemeColor = 'dim';
  private canManageKeys: boolean;

  constructor(
    keyInfo: KeyInfo[] | null,
    credits: number | null,
    rollupStatus: RollupStatus,
    error: string | null,
    theme: Theme,
    onClose: () => void,
    requestRender: () => void,
    ctx?: ExtensionContext,
    canManageKeys = true,
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
    this.canManageKeys = canManageKeys;
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
    if (matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
      return;
    }

    if (matchesKey(data, 'escape')) {
      if (this.confirmationHash) {
        this.confirmationHash = null;
        this.invalidate();
        return;
      }
      this.onClose();
      return;
    }

    if (this.pendingToggleHash) {
      return;
    }

    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      if (this.confirmationHash) {
        void this.confirmToggle();
      }
      return;
    }

    if (this.confirmationHash) {
      return;
    }

    if (matchesKey(data, 'r')) {
      void this.refresh();
      return;
    }

    if (matchesKey(data, 't')) {
      this.openToggleConfirmation();
      return;
    }

    if (this.keyInfo && this.keyInfo.length > 0) {
      if (matchesKey(data, 'up')) {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.inlineMessage = null;
        this.invalidate();
      } else if (matchesKey(data, 'down')) {
        this.selectedIndex = Math.min(this.keyInfo.length - 1, this.selectedIndex + 1);
        this.inlineMessage = null;
        this.invalidate();
      }
    }
  }

  wantsKeyRelease = false;

  render(width: number): string[] {
    const padding = Math.max(0, Math.floor((width - this.width) / 2));
    const pad = ' '.repeat(padding);

    return this.lines.map((line) => truncateToWidth(pad + line, width));
  }

  invalidate(): void {
    if (this.isDisposed) return;
    this.lines = this.buildLines();
    this.clampSelectedIndex();
    if (!this.isDisposed) {
      this.requestRender();
    }
  }

  async refresh(): Promise<void> {
    if (this.isDisposed || !this.ctx) return;

    const selectedHash = this.getSelectedKeyHash();

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

      this.canManageKeys = allKeys !== null;

      if (allKeys && allKeys.length > 0) {
        keyInfo = allKeys;
      } else {
        error = 'Key list unavailable - set OPENROUTER_MANAGEMENT_KEY for full key inventory.';
        try {
          const currentKey = await getCurrentKey();
          if (currentKey) {
            keyInfo = [currentKey];
            error = null;
          }
        } catch {
          // Ignore secondary errors
        }
      }

      const rollupStatus = keyInfo
        ? computeRollupStatus(keyInfo)
        : { status: 'unavailable' as const };

      this.keyInfo = keyInfo;
      this.credits = credits;
      this.rollupStatus = rollupStatus;
      this.error = error;
      this.confirmationHash = null;
      this.pendingToggleHash = null;
      this.width = this.calculateWidth();
      this.restoreSelectedIndexByHash(selectedHash);
      this.lines = this.buildLines();

      this.requestRender();
    } catch {
      // Silently ignore refresh errors
    }
  }

  private calculateWidth(): number {
    return MIN_WIDTH;
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

    if (this.keyInfo && this.keyInfo.length > 0) {
      const totalSpend = this.keyInfo.reduce((sum, k) => sum + k.spend, 0);
      lines.push(row(` usage      ${formatCurrency(totalSpend)}`, this.width));
    }

    if (this.credits !== null) {
      lines.push(row(` credits    ${formatCurrency(this.credits)}`, this.width));
    } else {
      lines.push(row(th.fg('dim', ' credits          unavailable'), this.width));
    }

    const rollupMessage =
      this.rollupStatus.status === 'unavailable' ? 'unavailable' : this.rollupStatus.message;
    lines.push(row(` status     ${rollupMessage}`, this.width));
    lines.push(emptyRow(this.width));

    if (this.keyInfo && this.keyInfo.length > 0) {
      const sortedKeys = sortKeys(this.keyInfo);
      this.clampSelectedIndex(sortedKeys);
      const currentKey = sortedKeys[this.selectedIndex] ?? sortedKeys[0] ?? null;

      if (currentKey) {
        lines.push(row(` ${th.fg('accent', 'Selected key')}`, this.width));
        lines.push(...this.buildKeyDetails(currentKey, th));
        if (!this.canManageKeys) {
          lines.push(
            row(
              th.fg('dim', '  readonly  Set OPENROUTER_MANAGEMENT_KEY to toggle keys.'),
              this.width,
            ),
          );
        }
        lines.push(...this.buildInlineStateLines(th));
        lines.push(emptyRow(this.width));
      }

      lines.push(row(` ${th.fg('accent', 'All keys')}`, this.width));
      lines.push(row(`   Workspace    Key name           Active   Spend    Used   `, this.width));
      for (let i = 0; i < sortedKeys.length; i++) {
        lines.push(this.buildCompactKeyRow(sortedKeys[i]!, th, i === this.selectedIndex));
      }
      lines.push(emptyRow(this.width));
    } else {
      lines.push(row(th.fg('dim', ' No keys available'), this.width));
    }

    lines.push(boxBottom(this.width));
    const footer =
      this.canManageKeys && this.keyInfo && this.keyInfo.length > 0
        ? 'Esc to close  ·  r to refresh  ·  ↑/↓ to select  ·  t to toggle'
        : 'Esc to close  ·  r to refresh  ·  ↑/↓ to select';
    lines.push(plainRow(th.fg('dim', footer), this.width));
    return lines;
  }

  private buildKeyDetails(key: KeyInfo, theme: Theme): string[] {
    const lines: string[] = [];
    const statusColor = this.getStatusColor(key.status);
    const formattedStatus = theme.fg(statusColor, key.status);
    const usedLimitText = formatRemaining(key.used, key.limit);
    const resetText = key.resetCadence || 'never';

    lines.push(row(`  name      ${truncate(key.name, 30)}`, this.width));
    lines.push(row(`  key       ${truncate(key.label, 30)}`, this.width));
    lines.push(row(`  status    ${formattedStatus}`, this.width));
    lines.push(row(`  used      ${usedLimitText}`, this.width));
    lines.push(row(`  reset     ${resetText}`, this.width));
    lines.push(row(`  byok      ${key.byok}`, this.width));

    return lines;
  }

  private buildInlineStateLines(theme: Theme): string[] {
    const lines: string[] = [];
    const targetHash = this.pendingToggleHash ?? this.confirmationHash;
    const targetKey = targetHash ? this.findKeyByHash(targetHash) : null;

    if (this.confirmationHash && targetKey) {
      const action = targetKey.disabled ? 'enable' : 'disable';
      lines.push(
        row(
          theme.fg(
            'warning',
            `  toggle    Press Enter to ${action} ${truncate(targetKey.name, 20)}`,
          ),
          this.width,
        ),
      );
      lines.push(row(theme.fg('dim', '            Esc to cancel'), this.width));
    }

    if (this.pendingToggleHash && targetKey) {
      const action = targetKey.disabled ? 'Enabling' : 'Disabling';
      lines.push(
        row(
          theme.fg('dim', `  status    ${action} ${truncate(targetKey.name, 20)}...`),
          this.width,
        ),
      );
    }

    if (this.inlineMessage) {
      const label = this.inlineMessageTone === 'error' ? 'error' : 'status';
      lines.push(
        row(theme.fg(this.inlineMessageTone, `  ${label}    ${this.inlineMessage}`), this.width),
      );
    }

    return lines;
  }

  private openToggleConfirmation(): void {
    if (!this.canManageKeys) {
      this.setInlineMessage('Set OPENROUTER_MANAGEMENT_KEY to enable or disable keys.', 'warning');
      this.invalidate();
      return;
    }

    const selectedKey = this.getSelectedKey();
    if (!selectedKey) {
      return;
    }

    this.confirmationHash = selectedKey.hash;
    this.inlineMessage = null;
    this.invalidate();
  }

  private async confirmToggle(): Promise<void> {
    if (!this.confirmationHash || this.pendingToggleHash || !this.keyInfo) {
      return;
    }

    const targetHash = this.confirmationHash;
    const currentKey = this.findKeyByHash(targetHash);
    if (!currentKey) {
      this.confirmationHash = null;
      this.setInlineMessage('Selected key is no longer available.', 'error');
      this.invalidate();
      return;
    }

    this.confirmationHash = null;
    this.pendingToggleHash = targetHash;
    this.inlineMessage = null;
    this.invalidate();

    try {
      const updated = await setApiKeyDisabled(targetHash, !currentKey.disabled);
      if (this.isDisposed) return;

      const updatedKey: KeyInfo = {
        ...currentKey,
        ...updated,
        hash: currentKey.hash,
        workspaceName: currentKey.workspaceName,
      };

      this.keyInfo = this.keyInfo.map((key) => (key.hash === targetHash ? updatedKey : key));
      this.rollupStatus = computeRollupStatus(this.keyInfo);
      this.pendingToggleHash = null;
      this.setInlineMessage(
        `${updatedKey.name} ${updatedKey.disabled ? 'disabled' : 'enabled'}.`,
        'success',
      );
      this.restoreSelectedIndexByHash(targetHash);
      this.invalidate();
    } catch (error_) {
      if (this.isDisposed) return;
      this.pendingToggleHash = null;
      const action = currentKey.disabled ? 'enable' : 'disable';
      this.setInlineMessage(
        `Failed to ${action} ${currentKey.name}: ${getSafeToggleErrorMessage(error_)}`,
        'error',
      );
      this.restoreSelectedIndexByHash(targetHash);
      this.invalidate();
    }
  }

  private setInlineMessage(message: string, tone: ThemeColor): void {
    this.inlineMessage = message;
    this.inlineMessageTone = tone;
  }

  private getSelectedKey(sortedKeys?: KeyInfo[]): KeyInfo | null {
    const keys = sortedKeys ?? this.getSortedKeys();
    if (keys.length === 0) return null;
    const index = Math.max(0, Math.min(this.selectedIndex, keys.length - 1));
    return keys[index] ?? null;
  }

  private getSelectedKeyHash(): string | null {
    return this.getSelectedKey()?.hash ?? null;
  }

  private findKeyByHash(hash: string): KeyInfo | null {
    if (!this.keyInfo) return null;
    return this.keyInfo.find((key) => key.hash === hash) ?? null;
  }

  private getSortedKeys(): KeyInfo[] {
    return this.keyInfo ? sortKeys(this.keyInfo) : [];
  }

  private restoreSelectedIndexByHash(hash: string | null): void {
    const sortedKeys = this.getSortedKeys();
    if (!hash || sortedKeys.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    const index = sortedKeys.findIndex((key) => key.hash === hash);
    this.selectedIndex = index >= 0 ? index : 0;
  }

  private clampSelectedIndex(sortedKeys?: KeyInfo[]): void {
    const keys = sortedKeys ?? this.getSortedKeys();
    if (keys.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    if (this.selectedIndex >= keys.length) {
      this.selectedIndex = keys.length - 1;
    }
    if (this.selectedIndex < 0) {
      this.selectedIndex = 0;
    }
  }

  private simplifiedWorkspaceName(workspaceName: string): string {
    return workspaceName.replace(/Workspace$/, '').trim();
  }

  private buildCompactKeyRow(key: KeyInfo, theme: Theme, isSelected: boolean): string {
    let spendText: string;
    if (key.disabled) {
      spendText = '-';
    } else {
      spendText = formatCurrency(key.spend);
    }

    let spendColor: ThemeColor = 'success';
    if (key.disabled) {
      spendColor = 'dim';
    } else if (key.spend >= 100) {
      spendColor = 'error';
    } else if (key.spend >= 50) {
      spendColor = 'warning';
    }

    const paddedSpend = padToWidth(theme.fg(spendColor, spendText), 8);

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

    const paddedUsage = padToWidth(theme.fg(usageColor, usageText), 5);

    const enabledIcon = key.disabled
      ? this.theme.fg('error', '\u2717')
      : this.theme.fg('success', '\u2713');

    const name = truncate(key.name, 28);
    const workspace = truncate(this.simplifiedWorkspaceName(key.workspaceName), 20);
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

function getSafeToggleErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/OPENROUTER_MANAGEMENT_KEY/i.test(message)) {
    return message;
  }
  return 'OpenRouter could not update the selected key. Check management-key permissions and refresh.';
}

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
