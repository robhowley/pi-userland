/**
 * Evaluation pipeline for the yolo-seatbelt safety guard.
 *
 * Phase A: Wires together the new RuleDefinition system with
 * pattern matching, path detection, and boundary checks.
 */

import { Decision, RuleDefinition, RuleSeverity } from './rules.js';
import { isProtectedPath } from './paths.js';
import { getBoundaryRule } from './boundary.js';
import { classifyWithConfig, hasMatch, classifyRule } from './matcher.js';

// Re-export Decision and rule types for convenience
export { Decision, RuleDefinition, RuleSeverity };

/**
 * Configuration for the evaluation pipeline
 *
 * All 18 built-in filters are configurable by rule ID.
 */
export interface Config {
  /** Log level: "none", "warn", or "debug" */
  logLevel?: 'none' | 'warn' | 'debug';
  /**
   * Rule severity overrides by rule ID.
   * Keys are rule IDs like "catastrophic.rm-rf-root", values are severity levels.
   * Absent rules use their built-in default severity.
   */
  rules?: Record<string, RuleSeverity>;
}

/**
 * Context object for evaluation
 */
export interface Context {
  /** Current working directory */
  cwd: string;
  /** Configuration overrides */
  config?: Config;
}

/**
 * Result of a decision evaluation
 */
export interface DecisionResult {
  /** The final decision: BLOCK, ASK, or ALLOW */
  decision: Decision;
  /** The rule that matched (e.g., "catastrophic.rm-rf-root", "git.push-force") */
  matchedRule: string;
  /** Human-readable explanation */
  message: string;
}

/**
 * Get the severity for a rule considering config overrides.
 *
 * @param rule - The rule definition
 * @param config - Optional config with rule overrides
 * @returns The effective severity (block, ask, or allow)
 */
function getEffectiveSeverity(rule: RuleDefinition, config?: Config): RuleSeverity {
  // Check if user has configured a specific severity for this rule
  const userOverride = config?.rules?.[rule.id];

  if (userOverride !== undefined) {
    // If rule is immutable, prevent downgrading below ASK
    if (rule.immutable && userOverride === 'allow') {
      return 'ask';
    }
    return userOverride;
  }

  return rule.defaultSeverity;
}

/**
 * Get the old-style rule name for backward compatibility with tests.
 * Maps new rule IDs to the old format (e.g., "block-rm-rf-root").
 */
function getOldStyleRuleName(rule: RuleDefinition): string {
  const id = rule.id;

  // catastrophic rules
  if (id === 'catastrophic.rm-rf-root') return 'block-rm-rf-root';
  if (id === 'catastrophic.rm-rf-git') return 'block-rm-rf-dot-git';
  if (id === 'catastrophic.rm-rf-home') return 'block-rm-rf-tilde';

  // protected-path rules
  if (id === 'protected-path.git') return 'block-protected-path';
  if (id === 'protected-path.env') return 'block-protected-path';
  if (id === 'protected-path.ssh') return 'block-protected-path';
  if (id === 'protected-path.npmrc') return 'block-protected-path';
  if (id === 'protected-path.pypirc') return 'block-protected-path';
  if (id === 'protected-path.netrc') return 'block-protected-path';
  if (id === 'protected-path.ssh-key') return 'block-protected-path';
  if (id === 'protected-path.pem') return 'block-protected-path';

  // destructive rules
  if (id === 'destructive.rm-rf') return 'ask-rm-rf';
  if (id === 'destructive.find-delete') return 'ask-find-delete';
  if (id === 'destructive.chmod-recursive') return 'ask-chmod-R';
  if (id === 'destructive.chown-recursive') return 'ask-chown-R';

  // privilege rules
  if (id === 'privilege.sudo') return 'ask-sudo';

  // git rules
  if (id === 'git.reset-hard') return 'ask-git-reset-hard';
  if (id === 'git.clean-force') return 'ask-git-clean-fdx';
  if (id === 'git.push-force') return 'ask-git-push-force';
  if (id === 'git.rebase-interactive') return 'ask-git-rebase-interactive';
  if (id === 'git.filter-branch') return 'ask-git-filter-branch';
  if (id === 'git.update-ref') return 'ask-git-update-ref';
  if (id === 'git.reflog-expire') return 'ask-git-reflog-expire';

  // boundary rules
  if (id === 'boundary.outside-workspace') return 'ask-outside-workspace';

  return 'unknown';
}

/**
 * Evaluate a command and return a detailed decision result.
 *
 * Evaluation order:
 * 1. Check PROTECTED_PATHS rules (from command arguments) → BLOCK
 * 2. Check BLOCK rules (catastrophic, protected-path patterns) → BLOCK
 * 3. Check workspace boundary (boundary.outside-workspace rule) → ASK or BLOCK
 * 4. Check ASK rules (destructive, privilege, git patterns) → ASK
 * 5. Default → ALLOW
 *
 * @param command - Raw command string to evaluate
 * @param context - Evaluation context (cwd, config)
 * @returns DecisionResult with decision, matchedRule, and message
 */
export function evaluate(command: string, context: Context): DecisionResult {
  const cwd = context.cwd;
  const config = context.config || {};

  // Step 1: Check if command contains protected paths (highest priority)
  // Extract potential paths from command
  const pathRegex = /(["']?)(\/(?:[^\s"']+\/?)+)\1|(["']?)\.\/([^\s"']+)["']?/g;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(command)) !== null) {
    const pathStr = match[2] || match[4];
    if (pathStr && isProtectedPath(pathStr)) {
      return {
        decision: Decision.BLOCK,
        matchedRule: 'block-protected-path',
        message: `Blocked: Command targets protected path "${pathStr}"`,
      };
    }
  }

  // Step 2: Check BLOCK rules (catastrophic and protected-path patterns)
  // Use classifyWithConfig to get severity considering overrides
  const blockRuleResult = classifyWithConfig(command, config);
  if (blockRuleResult && blockRuleResult.decision === 'block') {
    const rule = blockRuleResult.rule;
    // Use old-style message format
    const message =
      rule.id === 'catastrophic.rm-rf-root'
        ? 'Blocked: Command matches forbidden pattern'
        : rule.id === 'catastrophic.rm-rf-git'
          ? 'Blocked: Command matches forbidden pattern'
          : rule.id === 'catastrophic.rm-rf-home'
            ? 'Blocked: Command matches forbidden pattern'
            : `Blocked: Command matches forbidden pattern`;
    return {
      decision: Decision.BLOCK,
      matchedRule: getOldStyleRuleName(rule),
      message: message,
    };
  }

  // Step 3: Check workspace boundary (boundary.outside-workspace rule)
  const boundaryRule = getBoundaryRule(command, cwd);
  if (boundaryRule) {
    const severity = getEffectiveSeverity(boundaryRule, config);
    return {
      decision: severity === 'block' ? Decision.BLOCK : Decision.ASK,
      matchedRule: severity === 'block' ? 'block-outside-workspace' : 'ask-outside-workspace',
      message: `Path outside workspace`,
    };
  }

  // Step 4: Check ASK rules (destructive, privilege, git patterns)
  // Re-check with classifyWithConfig to get severity for non-block rules
  if (hasMatch(command)) {
    // Find the first matching rule with ask or allow severity
    const matchedRule = classifyWithConfig(command, config);
    if (matchedRule) {
      const severity = matchedRule.decision;
      if (severity === 'ask') {
        return {
          decision: Decision.ASK,
          matchedRule: getOldStyleRuleName(matchedRule.rule),
          message: `ASK: ${matchedRule.rule.description}`,
        };
      } else if (severity === 'allow') {
        // Rule matched but was configured to allow
        return {
          decision: Decision.ALLOW,
          matchedRule: getOldStyleRuleName(matchedRule.rule),
          message: `Allowed by configuration: ${matchedRule.rule.description}`,
        };
      }
    }
  }

  // Step 5: Default to ALLOW
  return {
    decision: Decision.ALLOW,
    matchedRule: 'allow-default',
    message: 'Command is allowed',
  };
}

/**
 * Quick evaluation that only checks if a command matches any rule.
 * Returns the decision enum for the matched rule without considering severity overrides.
 *
 * This is a simplified evaluation that doesn't check paths or workspace
 * boundaries. Useful for early filtering before more expensive checks.
 *
 * @param command - Raw command string
 * @returns Decision (BLOCK, ASK, or ALLOW)
 */
export function evaluateQuick(command: string): Decision {
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
 * Get a decision result for a command using quick evaluation.
 * Note: This uses the old behavior without config overrides.
 *
 * @param command - Raw command string
 * @returns DecisionResult with decision, matchedRule, and message
 */
export function evaluateQuickResult(command: string): DecisionResult {
  const rule = classifyRule(command);

  if (rule) {
    // For quick evaluation, use default severity
    if (rule.defaultSeverity === 'block') {
      return {
        decision: Decision.BLOCK,
        matchedRule: getOldStyleRuleName(rule),
        message: `Blocked: ${rule.description}`,
      };
    } else if (rule.defaultSeverity === 'ask') {
      return {
        decision: Decision.ASK,
        matchedRule: getOldStyleRuleName(rule),
        message: `ASK: ${rule.description}`,
      };
    }
  }

  return {
    decision: Decision.ALLOW,
    matchedRule: 'allow-default',
    message: 'Command is allowed',
  };
}
