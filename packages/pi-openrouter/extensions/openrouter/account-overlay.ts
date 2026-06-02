import { matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import type { ExtensionContext, Theme, ThemeColor } from '@mariozechner/pi-coding-agent';
import type { CurrentKeyRelation, KeyInfo, KeyStatus, RollupStatus } from './account-types.js';
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
  resolveCurrentKeyRelation,
  setApiKeyDisabled,
} from './account-client.js';

// =============================================================================
// Constants
// =============================================================================

const MIN_WIDTH = 65;

type ToggleGuard =
  | { canToggle: true; action: 'enable' | 'disable'; hash: string }
  | { canToggle: false; reason: string; tone: ThemeColor };

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
  private currentKeyRelation: CurrentKeyRelation | undefined;

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
    currentKeyRelation?: CurrentKeyRelation,
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
    this.currentKeyRelation = currentKeyRelation;
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
    if (this.pendingToggleHash) {
      return;
    }

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
      const keyInventory = await getAllKeys();
      let credits: number | null = null;
      try {
        credits = await getAccountCredits();
      } catch {
        // Silently ignore credit fetch errors
      }

      let error: string | null = null;
      let keyInfo: KeyInfo[] | null = null;
      let currentKeyRelation: CurrentKeyRelation | undefined;

      this.canManageKeys = keyInventory.canManageKeys;

      if (keyInventory.keys.length > 0) {
        keyInfo = keyInventory.keys;
        try {
          currentKeyRelation = await resolveCurrentKeyRelation(keyInfo);
        } catch {
          // Safe gating: disabling stays blocked until current-key identity is available.
        }
      } else if (keyInventory.degradedReason === 'management-unavailable') {
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
      } else if (keyInventory.degradedReason === 'missing-api-key') {
        error =
          'OpenRouter API key not found. Set OPENROUTER_MANAGEMENT_KEY (preferred) or OPENROUTER_API_KEY to use /openrouter-account.';
      }

      const rollupStatus = keyInfo
        ? computeRollupStatus(keyInfo)
        : { status: 'unavailable' as const };

      this.keyInfo = keyInfo;
      this.credits = credits;
      this.rollupStatus = rollupStatus;
      this.error = error;
      this.currentKeyRelation = currentKeyRelation;
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

    let selectedToggleAction: 'enable' | 'disable' | null = null;

    if (this.keyInfo && this.keyInfo.length > 0) {
      const sortedKeys = sortKeys(this.keyInfo);
      this.clampSelectedIndex(sortedKeys);
      const currentKey = sortedKeys[this.selectedIndex] ?? sortedKeys[0] ?? null;

      if (currentKey) {
        const toggleGuard = this.getToggleGuard(currentKey);
        if (toggleGuard.canToggle) {
          selectedToggleAction = toggleGuard.action;
        }

        lines.push(row(` ${th.fg('accent', 'Selected key')}`, this.width));
        lines.push(...this.buildKeyDetails(currentKey, th));
        if (!toggleGuard.canToggle) {
          lines.push(row(th.fg('dim', `  readonly  ${toggleGuard.reason}`), this.width));
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
    const footer = selectedToggleAction
      ? `Esc close  ·  r refresh  ·  ↑/↓ select  ·  t ${selectedToggleAction}`
      : 'Esc close  ·  r refresh  ·  ↑/↓ select';
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
    const selectedKey = this.getSelectedKey();
    if (!selectedKey) {
      return;
    }

    const toggleGuard = this.getToggleGuard(selectedKey);
    if (!toggleGuard.canToggle) {
      this.setInlineMessage(toggleGuard.reason, toggleGuard.tone);
      this.invalidate();
      return;
    }

    this.confirmationHash = toggleGuard.hash;
    this.inlineMessage = null;
    this.invalidate();
  }

  private async confirmToggle(): Promise<void> {
    if (!this.confirmationHash || this.pendingToggleHash || !this.keyInfo) {
      return;
    }

    const currentKey = this.findKeyByHash(this.confirmationHash);
    if (!currentKey) {
      this.confirmationHash = null;
      this.setInlineMessage('Selected key is no longer available.', 'error');
      this.invalidate();
      return;
    }

    const toggleGuard = this.getToggleGuard(currentKey);
    if (!toggleGuard.canToggle) {
      this.confirmationHash = null;
      this.setInlineMessage(toggleGuard.reason, toggleGuard.tone);
      this.invalidate();
      return;
    }

    const targetHash = toggleGuard.hash;
    this.confirmationHash = null;
    this.pendingToggleHash = targetHash;
    this.inlineMessage = null;
    this.invalidate();

    try {
      const updatedState = await setApiKeyDisabled(targetHash, !currentKey.disabled);

      const updatedKey: KeyInfo = {
        ...currentKey,
        ...updatedState,
        hash: targetHash,
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

  private getToggleGuard(key: KeyInfo): ToggleGuard {
    if (!this.canManageKeys) {
      return {
        canToggle: false,
        reason: 'Set OPENROUTER_MANAGEMENT_KEY to toggle keys.',
        tone: 'warning',
      };
    }

    if (!this.hasTrustedHash(key)) {
      return {
        canToggle: false,
        reason: 'This row is not backed by key inventory metadata.',
        tone: 'warning',
      };
    }

    const action = key.disabled ? 'enable' : 'disable';
    if (action === 'enable') {
      return { canToggle: true, action, hash: key.hash };
    }

    switch (this.currentKeyRelation?.kind) {
      case 'inventory-match':
        if (key.hash === this.currentKeyRelation.hash) {
          return {
            canToggle: false,
            reason: 'Cannot disable the active management key.',
            tone: 'warning',
          };
        }
        return { canToggle: true, action, hash: key.hash };
      case 'external-provisioning':
        return { canToggle: true, action, hash: key.hash };
      case 'ambiguous-label':
        if (this.currentKeyRelation.matchingHashes.includes(key.hash)) {
          return {
            canToggle: false,
            reason: 'Multiple keys match the current key label.',
            tone: 'warning',
          };
        }
        return { canToggle: true, action, hash: key.hash };
      default:
        return {
          canToggle: false,
          reason: 'Cannot verify current key matches this row.',
          tone: 'warning',
        };
    }
  }

  private hasTrustedHash(key: KeyInfo): key is KeyInfo & { hash: string } {
    return typeof key.hash === 'string' && key.hash.trim() !== '';
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

type ToggleErrorKind =
  | 'management-key-required'
  | 'management-key-permissions'
  | 'selected-key-invalid'
  | 'service-unavailable'
  | 'unknown';

function getSafeToggleErrorMessage(error: unknown): string {
  switch (getToggleErrorKind(error)) {
    case 'management-key-required':
      return 'Set OPENROUTER_MANAGEMENT_KEY to a valid management key, then refresh and try again.';
    case 'management-key-permissions':
      return 'OPENROUTER_MANAGEMENT_KEY does not have permission to update keys. Set it to a valid management key and refresh.';
    case 'selected-key-invalid':
      return 'OpenRouter could not match the selected key. Refresh the account view and try again.';
    case 'service-unavailable':
      return 'OpenRouter could not update the selected key right now. Retry in a moment and refresh.';
    default:
      return 'OpenRouter could not update the selected key. Refresh and try again.';
  }
}

function getToggleErrorKind(error: unknown): ToggleErrorKind {
  const statusCode = getErrorStatusCode(error);
  const message = getErrorMessage(error);
  const errorName = getErrorName(error);

  if (
    statusCode === 401 ||
    errorName === 'AuthError' ||
    /OPENROUTER_MANAGEMENT_KEY is required/i.test(message)
  ) {
    return 'management-key-required';
  }

  if (statusCode === 403 || /does not have permission/i.test(message)) {
    return 'management-key-permissions';
  }

  if (statusCode === 400 || statusCode === 404) {
    return 'selected-key-invalid';
  }

  if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return 'service-unavailable';
  }

  return 'unknown';
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const rawStatus =
    (error as { statusCode?: number | string; status?: number | string }).statusCode ??
    (error as { statusCode?: number | string; status?: number | string }).status;

  if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
    return rawStatus;
  }

  if (typeof rawStatus === 'string') {
    const parsed = Number(rawStatus);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getErrorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
