/**
 * Configuration loading for the yolo-seatbelt safety guard.
 *
 * Loads user configuration from ~/.pi/agent/yolo-seatbelt.json
 *
 * Configuration is fully rule-based - all 19 built-in filters
 * can be configured by rule ID.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleSeverity } from './rules.js';

/**
 * User configuration for yolo-seatbelt
 *
 * All built-in filters are configurable by rule ID.
 */
export interface Config {
  /** Log level: "none", "warn", or "debug" */
  logLevel: 'none' | 'warn' | 'debug';
  /** Exact tool names to block before tool-specific evaluation. */
  blockedTools: string[];
  /**
   * Rule severity overrides by rule ID.
   * Keys are rule IDs values are severity levels.
   * Absent rules use their built-in default severity.
   */
  rules?: Record<string, RuleSeverity>;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Config = {
  logLevel: 'none',
  blockedTools: [],
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
export function loadConfig(configPath?: string): Config {
  configPath = configPath ?? getConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      return DEFAULT_CONFIG;
    }

    const rawContent = fs.readFileSync(configPath, 'utf8');
    const parsedConfig: unknown = JSON.parse(rawContent);

    if (typeof parsedConfig !== 'object' || parsedConfig === null || Array.isArray(parsedConfig)) {
      return DEFAULT_CONFIG;
    }

    const userConfig = parsedConfig as {
      logLevel?: Config['logLevel'];
      rules?: Config['rules'];
      blockedTools?: unknown;
    };
    const blockedTools =
      userConfig.blockedTools === undefined ||
      (Array.isArray(userConfig.blockedTools) &&
        userConfig.blockedTools.every((tool) => typeof tool === 'string'))
        ? (userConfig.blockedTools ?? [])
        : [];

    // Merge with defaults - user rules take precedence
    return {
      logLevel: userConfig.logLevel ?? DEFAULT_CONFIG.logLevel,
      blockedTools,
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
