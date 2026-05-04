/**
 * Pattern matching utilities for the yolo-seatbelt safety guard.
 *
 * Simplified - single list of rules, no category concept.
 */

import { BUILTIN_RULES, RuleDefinition, RuleSeverity } from './rules.js';

export { BUILTIN_RULES } from './rules.js';
export type { RuleDefinition, RuleSeverity } from './rules.js';

/**
 * Get the effective severity for a rule (accounting for config overrides).
 */
function getEffectiveSeverity(
  rule: RuleDefinition,
  config?: { rules?: Record<string, RuleSeverity> },
): RuleSeverity {
  return config?.rules?.[rule.id] ?? rule.defaultSeverity;
}

/**
 * Sort rules by effective severity (BLOCK > ASK > ALLOW).
 * Config overrides are respected when determining effective severity.
 */
function sortByEffectiveSeverity(
  rules: RuleDefinition[],
  config?: { rules?: Record<string, RuleSeverity> },
): RuleDefinition[] {
  const SEVERITY_ORDER: Record<RuleSeverity, number> = { block: 0, ask: 1, allow: 2 };
  return [...rules].sort((a, b) => {
    const sevA = getEffectiveSeverity(a, config);
    const sevB = getEffectiveSeverity(b, config);
    return SEVERITY_ORDER[sevA] - SEVERITY_ORDER[sevB];
  });
}

/**
 * Get the matched rule for a command without checking severity.
 * Rules are evaluated in severity order: BLOCK > ASK > ALLOW.
 * Config overrides are respected when determining effective severity.
 *
 * @param command - Raw command string to classify
 * @param config - Optional config with rule overrides
 * @returns RuleDefinition if matched, undefined otherwise
 */
export function classifyRule(
  command: string,
  config?: { rules?: Record<string, RuleSeverity> },
): RuleDefinition | undefined {
  const sortedRules = sortByEffectiveSeverity(BUILTIN_RULES, config);
  for (const rule of sortedRules) {
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
  const rule = classifyRule(command, config);
  if (!rule) {
    return { decision: RuleSeverity.ALLOW, rule: null };
  }

  const severity = getEffectiveSeverity(rule, config);

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
