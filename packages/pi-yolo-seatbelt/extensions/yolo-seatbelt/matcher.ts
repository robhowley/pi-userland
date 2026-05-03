/**
 * Pattern matching utilities for the yolo-seatbelt safety guard.
 *
 * Phase A: Now uses the RuleDefinition system for rule lookup.
 * Provides classification based on configured rules with severity overrides.
 */

import { RuleDefinition, RuleSeverity, BUILTIN_RULES, Decision } from './rules.js';

// Re-export Decision for backward compatibility
export { Decision };

/**
 * Classify a command string into a decision based on pattern matching.
 *
 * Evaluation order:
 * 1. Check BLOCK rules → return BLOCK (highest priority)
 * 2. Check ASK rules → return ASK
 * 3. Default → ALLOW
 *
 * This uses the built-in rule definitions with their default severities.
 * For config-aware evaluation, use evaluate() from evaluate.ts.
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
 * Get the matched rule for a command without checking severity.
 *
 * @param command - Raw command string to classify
 * @returns RuleDefinition if matched, undefined otherwise
 */
export function classifyRule(command: string): RuleDefinition | undefined {
  // Check all rules in order of priority
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
export function classifyWithConfig(
  command: string,
  config?: { rules?: Record<string, RuleSeverity> },
): { decision: RuleSeverity; rule: RuleDefinition } | null {
  const rule = classifyRule(command);
  if (!rule) {
    return null;
  }

  // Get severity from config override if present, otherwise use default
  const severity = config?.rules?.[rule.id] ?? rule.defaultSeverity;

  return { decision: severity, rule };
}

/**
 * Quick classification that only checks if a command matches any rule.
 * Returns true if a rule matches (BLOCK or ASK), false otherwise (ALLOW).
 *
 * This is a simplified evaluation that doesn't check paths or workspace
 * boundaries. Useful for early filtering before more expensive checks.
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
 * @returns Array of matching RuleDefinitions (usually just one)
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
 * Get the matched pattern and its type for a command.
 * Useful for debugging and logging.
 *
 * This maintains backward compatibility with the old pattern-based API.
 * Returns the pattern index and type ('BLOCK' or 'ASK').
 *
 * Old pattern indices:
 * BLOCK: 0=rm-rf-root, 1=rm-rf-dot-git, 2=rm-rf-tilde
 * ASK: 0=rm-rf, 1=find-delete, 2=chmod-R, 3=chown-R, 4=sudo, 5=git-reset-hard,
 *      6=git-clean-fdx, 7=git-push-force, 8=git-rebase-interactive, 9=git-filter-branch,
 *      10=git-update-ref, 11=git-reflog-expire
 *
 * @param command - Raw command string
 * @returns Object with matched pattern index and decision type, or null if no match
 */
export function getMatchedPattern(
  command: string,
): { patternIndex: number; type: 'BLOCK' | 'ASK' } | null {
  // Check all rules in order
  for (const rule of BUILTIN_RULES) {
    if (rule.pattern.test(command)) {
      const type = rule.defaultSeverity === 'block' ? 'BLOCK' : 'ASK';

      // Map to old-style pattern index for backward compatibility
      // BLOCK patterns (indices 0-2)
      if (rule.id === 'catastrophic.rm-rf-root') return { patternIndex: 0, type };
      if (rule.id === 'catastrophic.rm-rf-git') return { patternIndex: 1, type };
      if (rule.id === 'catastrophic.rm-rf-home') return { patternIndex: 2, type };

      // ASK patterns (indices 0-11)
      // rm-rf was index 0 (but now we use 'destructive.rm-rf' as id, not wildcard)
      if (rule.id === 'destructive.rm-rf') return { patternIndex: 0, type };
      if (rule.id === 'destructive.find-delete') return { patternIndex: 1, type };
      if (rule.id === 'destructive.chmod-recursive') return { patternIndex: 2, type };
      if (rule.id === 'destructive.chown-recursive') return { patternIndex: 3, type };
      if (rule.id === 'privilege.sudo') return { patternIndex: 4, type };
      if (rule.id === 'git.reset-hard') return { patternIndex: 5, type };
      if (rule.id === 'git.clean-force') return { patternIndex: 6, type };
      if (rule.id === 'git.push-force') return { patternIndex: 7, type };
      if (rule.id === 'git.rebase-interactive') return { patternIndex: 8, type };
      if (rule.id === 'git.filter-branch') return { patternIndex: 9, type };
      if (rule.id === 'git.update-ref') return { patternIndex: 10, type };
      if (rule.id === 'git.reflog-expire') return { patternIndex: 11, type };

      return { patternIndex: 0, type };
    }
  }
  return null;
}
