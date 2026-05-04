/**
 * Pattern matching utilities for the yolo-seatbelt safety guard.
 *
 * Phase D: Simplified - single list of rules, no category concept.
 */

import { RuleDefinition, RuleSeverity, BUILTIN_RULES, Decision } from './rules.js';

/**
 * Get the matched rule for a command without checking severity.
 *
 * @param command - Raw command string to classify
 * @returns RuleDefinition if matched, undefined otherwise
 */
export function classifyRule(command: string): RuleDefinition | undefined {
  for (const rule of BUILTIN_RULES) {
    if (rule.pattern.test(command)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Classify a command string into a decision based on pattern matching.
 *
 * @param command - Raw command string to classify
 * @returns Decision indicating how to handle the command
 */
export function classify(command: string): Decision {
  const rule = classifyRule(command);
  if (!rule) {
    return Decision.ALLOW;
  }
  return rule.defaultSeverity === 'block'
    ? Decision.BLOCK
    : rule.defaultSeverity === 'ask'
      ? Decision.ASK
      : Decision.ALLOW;
}

/**
 * Get the severity for a command based on matched rules and config.
 *
 * @param command - Raw command string to evaluate
 * @param config - Optional config with rule overrides
 * @returns Object with decision and matched rule, or null if no match
 */
export function classifyWithConfig(
  command: string,
  config?: { rules?: Record<string, RuleSeverity> },
): { decision: RuleSeverity; rule: RuleDefinition } | null {
  const rule = classifyRule(command);
  if (!rule) {
    return null;
  }

  const severity = config?.rules?.[rule.id] ?? rule.defaultSeverity;

  return { decision: severity, rule };
}

/**
 * Quick classification that only checks if a command matches any rule.
 *
 * @param command - Raw command string
 * @returns true if command matches any built-in rule
 */
export function hasMatch(command: string): boolean {
  return classify(command) !== Decision.ALLOW;
}

/**
 * Get all rules that match a command.
 *
 * @param command - Raw command string
 * @returns Array of matching RuleDefinitions
 */
export function getMatchingRules(command: string): RuleDefinition[] {
  return BUILTIN_RULES.filter((rule) => rule.pattern.test(command));
}

/**
 * Get all matched rule IDs for a command.
 *
 * @param command - Raw command string
 * @returns Array of matching rule IDs
 */
export function getMatchingRuleIds(command: string): string[] {
  return getMatchingRules(command).map((rule) => rule.id);
}

/**
 * Get the matched rule and its type for a command.
 * Returns the rule ID for backward compatibility.
 *
 * @param command - Raw command string
 * @returns Object with matched rule ID, or null if no match
 */
export function getMatchedPattern(
  command: string,
): { patternIndex: number; type: 'BLOCK' | 'ASK' } | null {
  const rule = classifyRule(command);
  if (!rule) {
    return null;
  }

  const type = rule.defaultSeverity === 'block' ? 'BLOCK' : 'ASK';

  // Map rule IDs to old-style pattern indices for backward compatibility
  const BLOCK_PATTERN_IDS = ['rm-rf-root', 'rm-rf-git', 'rm-rf-home'];

  const ASK_PATTERN_IDS = [
    'rm-rf',
    'find-delete',
    'chmod-recursive',
    'chown-recursive',
    'sudo',
    'reset-hard',
    'clean-force',
    'push-force',
    'rebase-interactive',
    'filter-branch',
    'update-ref',
    'reflog-expire',
  ];

  const blockIndex = BLOCK_PATTERN_IDS.indexOf(rule.id);
  if (blockIndex >= 0) {
    return { patternIndex: blockIndex, type };
  }

  const askIndex = ASK_PATTERN_IDS.indexOf(rule.id);
  if (askIndex >= 0) {
    return { patternIndex: askIndex, type };
  }

  return null;
}
