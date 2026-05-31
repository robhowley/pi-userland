// Domain types for /openrouter-account command

/** Status of a single key based on usage/limit ratio */
export type KeyStatus =
  | 'healthy' // <70% used
  | 'caution' // 70-89% used
  | 'danger' // >=90% used
  | 'unbounded' // no key cap
  | 'partial' // missing required fields
  | 'disabled'; // disabled key

/** BYOK (Bring-Your-Own-Key) status */
export type BYOKStatus = 'incl' | 'excl' | '?';

/** Reset cadence for key limits */
export type ResetCadence = 'monthly' | 'weekly' | 'daily' | 'never' | 'partial';

/** Information about a single OpenRouter key */
export interface KeyInfo {
  name: string; // Human-readable name (e.g., "Production", "Development")
  label: string; // Key value (masked, e.g., "sk-or-v1-4a0...459")
  status: KeyStatus; // Current health status
  used: number; // Current usage (currency)
  limit?: number; // Key cap (optional)
  remaining?: number; // limit - used
  resetCadence: ResetCadence; // monthly, weekly, daily, never, or partial
  byok: BYOKStatus; // incl (true), excl (false), ? (unavailable)
  hash: string; // Key hash for identification
  disabled: boolean; // Whether key is disabled
  workspaceName: string; // Name of the workspace this key belongs to
  spend: number; // Spend associated with this key (in USD)
}

/** Rollup status for the entire account */
export type RollupStatus =
  | { status: 'unavailable'; message?: never }
  | { status: 'healthy'; message: string }
  | { status: 'caution'; message: string }
  | { status: 'danger'; message: string }
  | { status: 'disabled'; message: string };

/** Account credits info */
export interface AccountCredits {
  totalCredits: number; // Total credit cap
  totalUsage: number; // Total usage
  remaining?: number; // totalCredits - totalUsage
  available?: boolean; // Whether credits are available
}
