import { BLOCK_PATTERNS, ASK_PATTERNS, Decision } from './patterns.js';

/**
 * Classify a command string into a decision based on pattern matching.
 *
 * Evaluation order:
 * 1. Check BLOCK_PATTERNS → return BLOCK (highest priority)
 * 2. Check ASK_PATTERNS → return ASK
 * 3. Default → ALLOW
 *
 * @param command - Raw command string to classify
 * @returns Decision indicating how to handle the command
 */
export function classify(command: string): Decision {
  // Check BLOCK patterns first (always forbidden)
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(command)) {
      return Decision.BLOCK;
    }
  }

  // Check ASK patterns (require confirmation)
  for (const pattern of ASK_PATTERNS) {
    if (pattern.test(command)) {
      return Decision.ASK;
    }
  }

  // Default to ALLOW
  return Decision.ALLOW;
}

/**
 * Get the matched pattern and its type for a command.
 * Useful for debugging and logging.
 *
 * @param command - Raw command string
 * @returns Object with matched pattern index and decision type, or null if no match
 */
export function getMatchedPattern(
  command: string,
): { patternIndex: number; type: 'BLOCK' | 'ASK' } | null {
  // Check BLOCK patterns first
  for (let i = 0; i < BLOCK_PATTERNS.length; i++) {
    if (BLOCK_PATTERNS[i]?.test(command)) {
      return { patternIndex: i, type: 'BLOCK' };
    }
  }

  // Check ASK patterns
  for (let i = 0; i < ASK_PATTERNS.length; i++) {
    if (ASK_PATTERNS[i]?.test(command)) {
      return { patternIndex: i, type: 'ASK' };
    }
  }

  return null;
}
