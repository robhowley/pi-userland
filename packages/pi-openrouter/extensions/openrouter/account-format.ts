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
  
  if (usageRatio < 0.70) {
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
export function computeRollupStatus(
  keys: KeyInfo[], 
  currentKey?: KeyInfo
): RollupStatus {
  if (keys.length === 0) {
    return { status: 'unavailable' as const };
  }
  
  const hasDisabled = keys.some(k => k.status === 'disabled');
  const hasDanger = keys.some(k => k.status === 'danger');
  const hasCaution = keys.some(k => k.status === 'caution');
  const hasWatch = keys.some(k => k.status === 'watch');
  
  // Check if current key is special
  const currentIsDanger = currentKey?.status === 'danger';
  const currentIsCaution = currentKey?.status === 'caution';
  const currentIsWatch = currentKey?.status === 'watch';
  
  // Disabled keys take precedence
  if (hasDisabled) {
    const disabledKeys = keys.filter(k => k.status === 'disabled');
    const labels = disabledKeys.map(k => k.label).join(', ');
    return { 
      status: 'disabled' as const,
      message: `${disabledKeys.length} key${disabledKeys.length > 1 ? 's' : ''} disabled: ${labels}` 
    };
  }
  
  // Prioritize current runtime key status
  if (currentKey) {
    if (currentIsDanger) {
      return { 
        status: 'danger' as const,
        message: 'current key nearly exhausted' 
      };
    }
    if (currentIsCaution) {
      return { 
        status: 'caution' as const,
        message: 'current key near cap' 
      };
    }
    if (currentIsWatch) {
      return { 
        status: 'watch' as const,
        message: 'current key above 70%' 
      };
    }
  }
  
  // Otherwise: any danger/caution/watch among all keys
  if (hasDanger) {
    const dangerKeys = keys.filter(k => k.status === 'danger');
    const labels = dangerKeys.map(k => k.label).join(', ');
    return { 
      status: 'danger' as const,
      message: `${dangerKeys.length} key${dangerKeys.length > 1 ? 's' : ''} at limit: ${labels}` 
    };
  }
  
  if (hasCaution) {
    const cautionKeys = keys.filter(k => k.status === 'caution');
    return { 
      status: 'caution' as const,
      message: `${cautionKeys.length} key${cautionKeys.length > 1 ? 's' : ''} near cap` 
    };
  }
  
  if (hasWatch) {
    const watchKeys = keys.filter(k => k.status === 'watch');
    return { 
      status: 'watch' as const,
      message: `${watchKeys.length} key${watchKeys.length > 1 ? 's' : ''} above 70%` 
    };
  }
  
  // All healthy or unbounded
  if (keys.every(k => k.status === 'unbounded')) {
    return { 
      status: 'healthy' as const,
      message: `${keys.length} key${keys.length > 1 ? 's' : ''} visible (unlimited)` 
    };
  }
  
  return { 
    status: 'healthy' as const,
    message: `${keys.length} of ${keys.length} keys healthy` 
  };
}
