/**
 * Logging utilities for the yolo-seatbelt safety guard.
 *
 * Logs ASK/BLOCK decisions with configurable verbosity.
 */

import { RuleSeverity } from './rules';

/**
 * Log levels
 */
export type LogLevel = 'none' | 'warn' | 'debug';

/**
 * Log a decision
 *
 * @param decision - The decision made (BLOCK, ASK, or ALLOW)
 * @param command - The command that was evaluated
 * @param rule - The rule that matched
 * @param config - Configuration with log level
 */
export function logDecision(
  decision: RuleSeverity,
  command: string,
  rule: string,
  config: { logLevel: LogLevel },
): void {
  const { logLevel } = config;

  if (logLevel === 'none') {
    return;
  }

  const message = `[seatbelt] ${decision.toUpperCase()}: ${command} (rule: ${rule})`;

  if (logLevel === 'warn') {
    if (decision === RuleSeverity.BLOCK || decision === RuleSeverity.ASK) {
      console.warn(message);
    }
  } else if (logLevel === 'debug') {
    console.log(message);
  }
}
