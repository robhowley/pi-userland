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
  } else if (usageRatio < 0.9) {
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

/** Sort keys by priority: active first, then spend desc, then usage % desc */
export function sortKeys(keys: KeyInfo[]): KeyInfo[] {
  return [...keys].sort((a, b) => {
    // Active keys first (disabled = false before disabled = true)
    if (a.disabled !== b.disabled) {
      return a.disabled ? 1 : -1;
    }

    // Within active group: spend descending
    if (a.spend !== b.spend) {
      return b.spend - a.spend;
    }

    // Within active group with same spend: usage % descending
    const usagePercentA = a.limit ? (a.used / a.limit) * 100 : 0;
    const usagePercentB = b.limit ? (b.used / b.limit) * 100 : 0;
    if (usagePercentA !== usagePercentB) {
      return usagePercentB - usagePercentA;
    }

    // Alphabetically by name as tiebreaker
    return a.name.localeCompare(b.name);
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
  const red = keys.filter((k) => k.status === 'disabled' || k.status === 'danger').length;
  const yellow = keys.filter((k) => k.status === 'caution').length;
  const green = keys.filter((k) => k.status === 'healthy' || k.status === 'unbounded').length;

  return {
    status: 'healthy' as const,
    message: `🔴 ${red}  🟡 ${yellow}  🟢 ${green}`,
  };
}
