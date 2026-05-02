/**
 * Logging utilities for the yolo-seatbelt safety guard.
 * 
 * Logs ASK/BLOCK decisions with configurable verbosity.
 */

import { loadConfig } from './config.js';

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
  decision: 'BLOCK' | 'ASK' | 'ALLOW',
  command: string,
  rule: string,
  config: { logLevel: LogLevel }
): void {
  const { logLevel } = config;
  
  if (logLevel === 'none') {
    return;
  }
  
  const message = `[seatbelt] ${decision}: ${command} (rule: ${rule})`;
  
  if (logLevel === 'warn') {
    if (decision === 'BLOCK' || decision === 'ASK') {
      console.warn(message);
    }
  } else if (logLevel === 'debug') {
    console.log(message);
  }
}

/**
 * Log a blocked command with additional context
 * 
 * @param command - The command that was blocked
 * @param reason - Why it was blocked
 * @param config - Optional config override
 */
export function logBlock(command: string, reason: string, config?: { logLevel: LogLevel }): void {
  const logLevel = config?.logLevel ?? loadConfig().logLevel;
  if (logLevel !== 'none') {
    const message = `[seatbelt] BLOCK: ${command} (reason: ${reason})`;
    console.warn(message);
  }
}

/**
 * Log an asked command with additional context
 * 
 * @param command - The command that requires confirmation
 * @param config - Optional config override
 */
export function logAsk(command: string, config?: { logLevel: LogLevel }): void {
  const logLevel = config?.logLevel ?? loadConfig().logLevel;
  if (logLevel !== 'none') {
    const message = `[seatbelt] ASK: ${command}`;
    console.warn(message);
  }
}

/**
 * Log a debug message
 * 
 * @param message - The debug message
 */
export function logDebug(message: string): void {
  const config = loadConfig();
  if (config.logLevel === 'debug') {
    console.log(`[seatbelt] ${message}`);
  }
}
