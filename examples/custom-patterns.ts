/**
 * Custom Patterns Example
 *
 * This example shows how to extend yolo-seatbelt with custom patterns.
 * You can add new BLOCK or ASK patterns for project-specific rules.
 */

import { BLOCK_PATTERNS, ASK_PATTERNS } from './extensions/yolo-seatbelt/patterns.js';

// Add custom BLOCK pattern
const CUSTOM_BLOCK_PATTERNS = [
  ...BLOCK_PATTERNS,
  // Block any command containing "destroy"
  /\bdestroy\b/i,
];

// Add custom ASK pattern
const CUSTOM_ASK_PATTERNS = [
  ...ASK_PATTERNS,
  // Ask before running "git push" without --force
  /\bgit\s+push\b(?!.*--force)/,
];

/**
 * Check if a command matches any custom pattern
 */
function matchesCustomPattern(command: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    if (pattern.test(command)) {
      // Create a human-readable rule name
      const ruleName = pattern.toString().replace(/[\/\s]+/g, '-').slice(1, -1);
      return `custom-${ruleName}`;
    }
  }
  return null;
}

// Example usage
function checkCustomRules(command: string): void {
  const blockRule = matchesCustomPattern(command, CUSTOM_BLOCK_PATTERNS);
  if (blockRule) {
    console.log(`BLOCKED by custom rule: ${blockRule}`);
    return;
  }

  const askRule = matchesCustomPattern(command, CUSTOM_ASK_PATTERNS);
  if (askRule) {
    console.log(`ASK about: ${askRule}`);
    return;
  }

  console.log('Command passes custom rules');
}

// Examples
checkCustomRules('npm run destroy');           // BLOCKED by custom rule
checkCustomRules('git push');                  // ASK about: git-push
checkCustomRules('git push --force');          // Passes custom rules
checkCustomRules('echo hello');                // Passes custom rules
