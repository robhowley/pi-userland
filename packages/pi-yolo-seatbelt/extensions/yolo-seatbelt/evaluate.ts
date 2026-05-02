/**
 * Evaluation pipeline for the yolo-seatbelt safety guard.
 *
 * Wires together pattern matching, path detection, and boundary checks
 * into a unified decision function.
 */

import { BLOCK_PATTERNS, ASK_PATTERNS, Decision } from './patterns.js';
import { isProtectedPath } from './paths.js';
import { isInsideWorkspace } from './boundary.js';
import { classify } from './matcher.js';

// Re-export Decision for convenience
export { Decision };

/**
 * Configuration for the evaluation pipeline
 */
export interface Config {
  /** Behavior when path is outside workspace: "ask" (default) or "block" */
  outsideWorkspace?: 'ask' | 'block';
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
  /** The rule that matched (e.g., "block-rm-rf-root", "ask-git-reset") */
  matchedRule: string;
  /** Human-readable explanation */
  message: string;
}

/**
 * Extract the rule name from a matched pattern index and type.
 * Uses a mapping of known patterns to readable names.
 */
function getRuleName(patternIndex: number, type: 'BLOCK' | 'ASK'): string {
  const rulePrefix = type === 'BLOCK' ? 'block' : 'ask';

  // Known pattern names for readable rule output
  const blockPatternNames = ['rm-rf-root', 'rm-rf-dot-git', 'rm-rf-tilde'];

  const askPatternNames = [
    'rm-rf',
    'find-delete',
    'chmod-R',
    'chown-R',
    'sudo',
    'git-reset-hard',
    'git-clean-fdx',
    'git-push-force',
    'git-rebase-interactive',
    'git-filter-branch',
    'git-update-ref',
    'git-reflog-expire',
  ];

  const names = type === 'BLOCK' ? blockPatternNames : askPatternNames;
  const name = names[patternIndex] || `unknown-${patternIndex}`;

  return `${rulePrefix}-${name}`;
}

/**
 * Evaluate a command and return a detailed decision result.
 *
 * Evaluation order:
 * 1. Check PROTECTED_PATHS (from command arguments) → return BLOCK
 * 2. Check BLOCK_PATTERNS → return BLOCK
 * 3. Check workspace boundary → return ASK or BLOCK (config)
 * 4. Check ASK_PATTERNS → return ASK
 * 5. Default → ALLOW
 *
 * @param command - Raw command string to evaluate
 * @param context - Evaluation context (cwd, config)
 * @returns DecisionResult with decision, matchedRule, and message
 */
export function evaluate(command: string, context: Context): DecisionResult {
  const cwd = context.cwd;
  const config = context.config || {};
  const outsideWorkspaceBehavior = config.outsideWorkspace || 'ask';

  // Step 1: Check if command contains protected paths (highest priority for path-based blocks)
  // Extract potential paths from command (simplified: look for patterns like /path or ./path)
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

  // Step 2: Check BLOCK patterns (highest priority for pattern-based blocks)
  for (let i = 0; i < BLOCK_PATTERNS.length; i++) {
    if (BLOCK_PATTERNS[i]?.test(command)) {
      return {
        decision: Decision.BLOCK,
        matchedRule: getRuleName(i, 'BLOCK'),
        message: `Blocked: Command matches forbidden pattern`,
      };
    }
  }

  // Step 3: Check workspace boundary
  // Check if command contains paths outside workspace
  const absolutePathRegex = /(["']?)(\/(?:[^\s"']+\/?)+)\1/g;
  while ((match = absolutePathRegex.exec(command)) !== null) {
    const pathStr = match[2];
    if (pathStr && !isInsideWorkspace(pathStr, cwd)) {
      if (outsideWorkspaceBehavior === 'block') {
        return {
          decision: Decision.BLOCK,
          matchedRule: 'block-outside-workspace',
          message: `Blocked: Path "${pathStr}" is outside workspace`,
        };
      } else {
        return {
          decision: Decision.ASK,
          matchedRule: 'ask-outside-workspace',
          message: `Command targets path "${pathStr}" outside workspace`,
        };
      }
    }
  }

  // Step 4: Check ASK patterns
  for (let i = 0; i < ASK_PATTERNS.length; i++) {
    if (ASK_PATTERNS[i]?.test(command)) {
      return {
        decision: Decision.ASK,
        matchedRule: getRuleName(i, 'ASK'),
        message: `ASK: Command matches potentially dangerous pattern`,
      };
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
 * Quick evaluation that only checks BLOCK patterns and ASK patterns.
 *
 * This is a simplified evaluation that doesn't check paths or workspace
 * boundaries. Useful for early filtering before more expensive checks.
 *
 * @param command - Raw command string
 * @returns Decision (BLOCK, ASK, or ALLOW)
 */
export function evaluateQuick(command: string): Decision {
  return classify(command);
}

/**
 * Get a decision result for a command using quick evaluation.
 *
 * @param command - Raw command string
 * @returns DecisionResult with decision, matchedRule, and message
 */
export function evaluateQuickResult(command: string): DecisionResult {
  const decision = evaluateQuick(command);

  if (decision === Decision.BLOCK) {
    // Find which pattern matched
    for (let i = 0; i < BLOCK_PATTERNS.length; i++) {
      if (BLOCK_PATTERNS[i]?.test(command)) {
        return {
          decision: Decision.BLOCK,
          matchedRule: getRuleName(i, 'BLOCK'),
          message: 'Blocked: Command matches forbidden pattern',
        };
      }
    }
  }

  if (decision === Decision.ASK) {
    for (let i = 0; i < ASK_PATTERNS.length; i++) {
      if (ASK_PATTERNS[i]?.test(command)) {
        return {
          decision: Decision.ASK,
          matchedRule: getRuleName(i, 'ASK'),
          message: 'ASK: Command matches potentially dangerous pattern',
        };
      }
    }
  }

  return {
    decision: Decision.ALLOW,
    matchedRule: 'allow-default',
    message: 'Command is allowed',
  };
}
