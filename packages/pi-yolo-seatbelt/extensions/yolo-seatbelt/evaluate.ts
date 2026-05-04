/**
 * Evaluation pipeline for the yolo-seatbelt safety guard.
 *
 * Single evaluation function using classifyWithConfig for all checks.
 */

import { classify } from './matcher.js';
import { RuleSeverity } from './rules.js';

// Re-export Decision for convenience
export { RuleSeverity };

/**
 * Configuration for the evaluation pipeline
 */
export interface Config {
  /** Log level: "none", "warn", or "debug" */
  logLevel?: 'none' | 'warn' | 'debug';
  /**
   * Rule severity overrides by rule ID.
   * Keys are rule IDs like "rm-rf-root", values are severity levels.
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
  decision: RuleSeverity;
  /** The rule that matched (e.g., "rm-rf-root") */
  matchedRule?: string;
  /** Human-readable explanation */
  message?: string;
}


/**
 * Evaluate a command and return a detailed decision result.
 * First match wins across all checks.
 *
 * @param command - Raw command string to evaluate
 * @param context - Evaluation context (cwd, config)
 * @returns DecisionResult with decision, matchedRule, and message
 */
export function evaluate(command: string, context: Context): DecisionResult {
  const config = context.config || {};

  const matchedRule = classify(command, config);

  return {
    decision: matchedRule.decision,
    matchedRule: matchedRule.rule?.id || 'allow-default',
    message: `${matchedRule.decision.toUpperCase()}: ${matchedRule.rule?.description || 'Command is allowed'}`,
  };
}
