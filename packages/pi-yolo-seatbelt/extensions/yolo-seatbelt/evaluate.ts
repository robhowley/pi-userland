/**
 * Evaluation pipeline for the yolo-seatbelt safety guard.
 *
 * Phase B: Wires together the new RuleDefinition system with
 * pattern matching, path detection, and boundary checks.
 */

import { Decision } from './rules.js';
import { isProtectedPath } from './paths.js';
import { getBoundaryRule } from './boundary.js';
import { classifyWithConfig, hasMatch, classifyRule } from './matcher.js';
import type { RuleDefinition, RuleSeverity } from './rules.js';

// Re-export Decision for convenience
export { Decision };

/**
 * Configuration for the evaluation pipeline
 *
 * All 18 built-in filters are configurable by rule ID or category.
 */
export interface Config {
  /** Log level: "none", "warn", or "debug" */
  logLevel?: 'none' | 'warn' | 'debug';
  /**
   * Category severity overrides.
   * Categories: irreversible, trust-boundary, git-history
   */
  categories?: {
    irreversible?: RuleSeverity;
    'trust-boundary'?: RuleSeverity;
    'git-history'?: RuleSeverity;
  };
  /**
   * Rule severity overrides by rule ID.
   * Keys are rule IDs like "irreversible.rm-rf-root", values are severity levels.
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
  /** The rule that matched (e.g., "irreversible.rm-rf-root") */
  matchedRule: string;
  /** Human-readable explanation */
  message: string;
}

/**
 * Get the severity for a rule considering config overrides.
 * Priority: rule-specific > default
 *
 * @param rule - The rule definition
 * @param config - Optional config with rule overrides
 * @returns The effective severity (block, ask, or allow)
 */
function getEffectiveSeverity(rule: RuleDefinition, config?: Config): RuleSeverity {
  // Priority 1: Rule-specific override
  const ruleOverride = config?.rules?.[rule.id];
  if (ruleOverride !== undefined) {
    return ruleOverride;
  }

  // Priority 2: Default severity
  return rule.defaultSeverity;
}

/**
 * Get the old-style rule name for backward compatibility with tests.
 * Maps new rule IDs to the old format (e.g., "block-rm-rf-root").
 */
function getOldStyleRuleName(rule: RuleDefinition): string {
  const id = rule.id;

  // Block rules (catastrophic)
  if (id === 'rm-rf-root') return 'block-rm-rf-root';
  if (id === 'rm-rf-git') return 'block-rm-rf-dot-git';
  if (id === 'rm-rf-home') return 'block-rm-rf-tilde';

  // Protected path rules (block)
  if (id === 'path-git') return 'block-protected-path';
  if (id === 'path-env') return 'block-protected-path';
  if (id === 'path-ssh') return 'block-protected-path';
  if (id === 'path-npmrc') return 'block-protected-path';
  if (id === 'path-pypirc') return 'block-protected-path';
  if (id === 'path-netrc') return 'block-protected-path';
  if (id === 'path-ssh-key') return 'block-protected-path';
  if (id === 'path-pem') return 'block-protected-path';

  // Ask rules (destructive)
  if (id === 'rm-rf') return 'ask-rm-rf';
  if (id === 'find-delete') return 'ask-find-delete';
  if (id === 'chmod-recursive') return 'ask-chmod-R';
  if (id === 'chown-recursive') return 'ask-chown-R';
  if (id === 'outside-workspace') return 'ask-outside-workspace';

  // Trust boundary rules
  if (id === 'sudo') return 'ask-sudo';

  // Git history rules
  if (id === 'reset-hard') return 'ask-git-reset-hard';
  if (id === 'clean-force') return 'ask-git-clean-fdx';
  if (id === 'push-force') return 'ask-git-push-force';
  if (id === 'rebase-interactive') return 'ask-git-rebase-interactive';
  if (id === 'filter-branch') return 'ask-git-filter-branch';
  if (id === 'update-ref') return 'ask-git-update-ref';
  if (id === 'reflog-expire') return 'ask-git-reflog-expire';

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

  // Step 2: Check BLOCK rules (irreversible - catastrophic and protected-path patterns)
  const blockRuleResult = classifyWithConfig(command, config);
  if (blockRuleResult && blockRuleResult.decision === 'block') {
    const rule = blockRuleResult.rule;
    return {
      decision: Decision.BLOCK,
      matchedRule: getOldStyleRuleName(rule),
      message: 'Blocked: Command matches forbidden pattern',
    };
  }

  // Step 3: Check workspace boundary (boundary.outside-workspace rule)
  const boundaryRule = getBoundaryRule(command, cwd);
  if (boundaryRule) {
    const severity = getEffectiveSeverity(boundaryRule, config);
    return {
      decision: severity === 'block' ? Decision.BLOCK : Decision.ASK,
      matchedRule: severity === 'block' ? 'block-outside-workspace' : 'ask-outside-workspace',
      message: 'Path outside workspace',
    };
  }

  // Step 4: Check ASK rules (destructive, privilege, git patterns)
  if (hasMatch(command)) {
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
 * Returns the decision enum for the matched rule.
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
 *
 * @param command - Raw command string
 * @returns DecisionResult with decision, matchedRule, and message
 */
export function evaluateQuickResult(command: string): DecisionResult {
  const rule = classifyRule(command);

  if (rule) {
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
