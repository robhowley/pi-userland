/**
 * Configuration loading for the yolo-seatbelt safety guard.
 *
 * Loads user configuration from ~/.pi/agent/yolo-seatbelt.json
 *
 * Configuration is now fully rule-based - all 18 built-in filters
 * can be configured by their rule IDs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleSeverity } from './rules.js';

/**
 * User configuration for yolo-seatbelt
 *
 * All 18 built-in filters are configurable by rule ID.
 * Examples: "catastrophic.rm-rf-root", "git.push-force", "boundary.outside-workspace"
 */
export interface Config {
  /** Log level: "none", "warn", or "debug" */
  logLevel?: 'none' | 'warn' | 'debug';
  /**
   * Rule severity overrides by rule ID.
   * Keys are rule IDs like "catastrophic.rm-rf-root", values are severity levels.
   * Absent rules use their built-in default severity.
   */
  rules: Record<string, RuleSeverity>;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Config = {
  logLevel: 'none',
  rules: {},
};

/**
 * Get the path to the user's yolo-seatbelt config file
 */
export function getConfigPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'yolo-seatbelt.json');
}

/**
 * Load user configuration from ~/.pi/agent/yolo-seatbelt.json
 * Returns default config if file doesn't exist or is invalid
 *
 * @returns User configuration with defaults applied
 */
export function loadConfig(): Config {
  const configPath = getConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      return DEFAULT_CONFIG;
    }

    const rawContent = fs.readFileSync(configPath, 'utf8');
    const userConfig = JSON.parse(rawContent) as Config;

    // Merge with defaults - user rules take precedence
    return {
      logLevel: userConfig.logLevel ?? DEFAULT_CONFIG.logLevel,
      rules: {
        ...DEFAULT_CONFIG.rules,
        ...userConfig.rules,
      },
    };
  } catch (error) {
    // If file exists but is invalid, return defaults
    console.warn(`[seatbelt] Failed to load config from ${configPath}: ${error}`);
    return DEFAULT_CONFIG;
  }
}
