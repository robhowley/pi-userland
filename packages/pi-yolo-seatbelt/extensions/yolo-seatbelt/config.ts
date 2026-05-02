/**
 * Configuration loading for the yolo-seatbelt safety guard.
 * 
 * Loads user configuration from ~/.pi/agent/yolo-seatbelt.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * User configuration for yolo-seatbelt
 */
export interface Config {
  /** Behavior when path is outside workspace: "ask" (default) or "block" */
  outsideWorkspace?: 'ask' | 'block';
  /** Log level: "none", "warn", or "debug" */
  logLevel?: 'none' | 'warn' | 'debug';
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Config = {
  outsideWorkspace: 'ask',
  logLevel: 'none',
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
    
    // Merge with defaults (only override specified values)
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      // Validate logLevel if provided
      logLevel: userConfig.logLevel ?? DEFAULT_CONFIG.logLevel,
      // Validate outsideWorkspace if provided
      outsideWorkspace: userConfig.outsideWorkspace ?? DEFAULT_CONFIG.outsideWorkspace,
    };
  } catch (error) {
    // If file exists but is invalid, return defaults
    console.warn(`[seatbelt] Failed to load config from ${configPath}: ${error}`);
    return DEFAULT_CONFIG;
  }
}
