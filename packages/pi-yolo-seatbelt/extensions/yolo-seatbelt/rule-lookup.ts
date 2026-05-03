/**
 * Rule lookup utilities for the yolo-seatbelt safety guard.
 *
 * Phase A: Provides mapping between pattern indices and rule IDs
 * for backward compatibility while migrating to RuleDefinition system.
 */

import { RuleDefinition } from './rules.js';

/**
 * Mapping of pattern indices to rule IDs for BLOCK patterns
 * Used for backward compatibility with old pattern-based code
 */
export const BLOCK_PATTERN_TO_RULE: Record<number, string> = {
  0: 'catastrophic.rm-rf-root',
  1: 'catastrophic.rm-rf-git',
  2: 'catastrophic.rm-rf-home',
};

/**
 * Mapping of pattern indices to rule IDs for ASK patterns
 * Used for backward compatibility with old pattern-based code
 */
export const ASK_PATTERN_TO_RULE: Record<number, string> = {
  0: 'destructive.rm-rf-wildcard',
  1: 'destructive.find-delete',
  2: 'destructive.chmod-recursive',
  3: 'destructive.chown-recursive',
  4: 'privilege.sudo',
  5: 'git.reset-hard',
  6: 'git.clean-force',
  7: 'git.push-force',
  8: 'git.rebase-interactive',
  9: 'git.filter-branch',
  10: 'git.update-ref',
  11: 'git.reflog-expire',
};

/**
 * Get rule ID from old-style pattern index and type
 * Used for backward compatibility during migration
 *
 * @param patternIndex - The index from the old pattern arrays
 * @param type - Either 'BLOCK' or 'ASK' for the old pattern type
 * @returns The corresponding rule ID, or 'unknown' if not found
 */
export function getRuleIdFromIndex(patternIndex: number, type: 'BLOCK' | 'ASK'): string {
  if (type === 'BLOCK') {
    return BLOCK_PATTERN_TO_RULE[patternIndex] ?? `unknown-block-${patternIndex}`;
  } else {
    return ASK_PATTERN_TO_RULE[patternIndex] ?? `unknown-ask-${patternIndex}`;
  }
}

/**
 * Find the first rule that matches a command
 *
 * @param command - The command string to test
 * @param rules - Array of rules to check against
 * @returns The first matching RuleDefinition, or undefined if no match
 */
export function findMatchingRule(
  command: string,
  rules: RuleDefinition[],
): RuleDefinition | undefined {
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Find all rules that match a command
 *
 * @param command - The command string to test
 * @param rules - Array of rules to check against
 * @returns Array of all matching RuleDefinitions
 */
export function findMatchingRules(command: string, rules: RuleDefinition[]): RuleDefinition[] {
  return rules.filter((rule) => rule.pattern.test(command));
}

/**
 * Get all rule IDs that match a command
 *
 * @param command - The command string to test
 * @param rules - Array of rules to check against
 * @returns Array of matching rule IDs
 */
export function getMatchingRuleIds(command: string, rules: RuleDefinition[]): string[] {
  return findMatchingRules(command, rules).map((rule) => rule.id);
}
