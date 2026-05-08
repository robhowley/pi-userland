import type { KeyInfo, KeyStatus, RollupStatus } from './account-types.js';

// =============================================================================
// Status Computation
// =============================================================================

/** Compute KeyStatus based on usage/limit ratio */
export function computeKeyStatus(used: number, limit?: number, disabled?: boolean): KeyStatus {
  // Disabled keys always show disabled
  if (disabled) return 'disabled';

  // No limit means unbounded
  if (limit === undefined) return 'unbounded';

  const usageRatio = used / limit;

  if (usageRatio < 0.7) {
    return 'healthy';
  } else if (usageRatio < 0.85) {
    return 'watch';
  } else if (usageRatio < 0.95) {
    return 'caution';
  } else {
    return 'danger';
  }
}

// =============================================================================
// Formatting
// =============================================================================

/** Format currency amount */
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Format remaining with optional limit */
export function formatRemaining(used: number, limit?: number): string {
  if (limit === undefined) {
    return `${formatCurrency(used)} / unlimited`;
  }
  return `${formatCurrency(used)} / ${formatCurrency(limit)}`;
}

/** Format remaining text */
export function formatLeft(remaining?: number): string {
  if (remaining === undefined) return '-';
  return formatCurrency(remaining);
}

// =============================================================================
// Sorting
// =============================================================================

/** Sort keys by priority: current key first, then by status, then alphabetically */
export function sortKeys(keys: KeyInfo[], currentHash?: string): KeyInfo[] {
  const statusPriority: Record<string, number> = {
    danger: 0,
    caution: 1,
    watch: 2,
    disabled: 3,
    partial: 4,
    healthy: 5,
    unbounded: 6,
  };

  return [...keys].sort((a, b) => {
    // Current key first
    if (a.hash === currentHash && b.hash !== currentHash) return -1;
    if (b.hash === currentHash && a.hash !== currentHash) return 1;

    // Then by status priority
    const statusDiff = (statusPriority[a.status] ?? 0) - (statusPriority[b.status] ?? 0);
    if (statusDiff !== 0) return statusDiff;

    // Then alphabetically by label
    return a.label.localeCompare(b.label);
  });
}

// =============================================================================
// Rollup Status
// =============================================================================

/** Compute overall account status from individual key statuses */
export function computeRollupStatus(keys: KeyInfo[]): RollupStatus {
  if (keys.length === 0) {
    return { status: 'unavailable' as const };
  }

  // Count keys by traffic light status
  const red = keys.filter(k => k.status === 'disabled' || k.status === 'danger').length;
  const yellow = keys.filter(k => k.status === 'caution' || k.status === 'watch').length;
  const green = keys.filter(k => k.status === 'healthy' || k.status === 'unbounded').length;

  return {
    status: 'healthy' as const,
    message: `🔴 ${red}  🟡 ${yellow}  🟢 ${green}`,
  };
}
