/**
 * Pattern matching utilities for the yolo-seatbelt safety guard.
 *
 * Simplified - single list of rules, no category concept.
 */

import { BUILTIN_RULES, RuleDefinition, RuleSeverity } from './rules.js';

export { BUILTIN_RULES } from './rules.js';
export type { RuleDefinition, RuleSeverity } from './rules.js';

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
 * Get the severity for a command based on matched rules and config.
 *
 * @param command - Raw command string to evaluate
 * @param config - Optional config with rule overrides
 * @returns Object with decision and matched rule, or null if no match
 */
export function classify(
  command: string,
  config?: { rules?: Record<string, RuleSeverity> },
): { decision: RuleSeverity; rule: RuleDefinition | null } {
  const rule = classifyRule(command);
  if (!rule) {
    return { decision: RuleSeverity.ALLOW, rule: null };
  }

  const severity = config?.rules?.[rule.id] ?? rule.defaultSeverity;

  return { decision: severity, rule };
}

/**
 * Check if a command matches any rule.
 *
 * @param command - Raw command string
 * @returns true if command matches any built-in rule
 */
// export function hasMatch(command: string): boolean {
//   return classify(command) !== Decision.ALLOW;
// }

/**
 * Get all matched rule IDs for a command.
 *
 * @param command - Raw command string
 * @returns Array of matching rule IDs
 */
export function getMatchingRuleIds(command: string): string[] {
  return BUILTIN_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => rule.id);
}
