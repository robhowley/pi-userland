/**
 * Pattern definitions for the yolo-seatbelt safety guard.
 *
 * BLOCK_PATTERNS: Commands that should never execute without human intervention
 * ASK_PATTERNS: Commands that require user confirmation before execution
 * ALLOW_PATTERNS: Commands explicitly marked as safe (optional, defaults to everything else)
 */

/** Commands that are always blocked - no way to proceed */
export const BLOCK_PATTERNS = [
  /\brm\s+-rf\s+\//, // rm -rf / (blocks any path starting with /)
  /\brm\s+-rf\s+\.git\b/, // rm -rf .git
  /\brm\s+-rf\s+~(?=\s|$)/, // rm -rf ~ (with word boundary after ~)
];

/** Commands that require user confirmation */
export const ASK_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bfind\s+.*-delete\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\bsudo\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[^\s][fdx]/,
  /\bgit\s+push\b.*--force/,
  /\bgit\s+rebase\s+-i\b/,
  /\bgit\s+filter-branch\b/,
  /\bgit\s+update-ref\b/,
  /\bgit\s+reflog\s+expire\b/,
];

/** Commands explicitly allowed (override patterns) */
export const ALLOW_PATTERNS: RegExp[] = [];

/**
 * Decision enum for command classification
 */
export enum Decision {
  BLOCK = 'BLOCK',
  ASK = 'ASK',
  ALLOW = 'ALLOW',
}
