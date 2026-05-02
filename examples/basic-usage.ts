/**
 * Basic Usage Example
 *
 * This example shows how to use yolo-seatbelt programmatically
 * to evaluate shell commands before execution.
 */

import { evaluate } from './extensions/yolo-seatbelt/evaluate.js';
import { Decision } from './extensions/yolo-seatbelt/evaluate.js';

/**
 * Evaluate a command and handle the decision
 */
function handleCommand(command: string): void {
  const result = evaluate(command, {
    cwd: process.cwd(),
    config: { outsideWorkspace: 'ask' },
  });

  switch (result.decision) {
    case Decision.BLOCK:
      console.log(`❌ BLOCKED: ${result.message}`);
      console.log(`   Rule: ${result.matchedRule}`);
      break;

    case Decision.ASK:
      console.log(`⚠️  ASK: ${result.message}`);
      console.log(`   Rule: ${result.matchedRule}`);
      // In a real app, prompt user here
      break;

    case Decision.ALLOW:
      console.log(`✅ ALLOWED: ${result.message}`);
      // Execute the command
      break;
  }
}

// Example usage
handleCommand('rm -rf /tmp/test');  // ASK - matches ask-rm-rf pattern
handleCommand('echo hello');        // ALLOW - safe command
handleCommand('git reset --hard');  // ASK - matches git-reset-hard pattern
handleCommand('ls -la');            // ALLOW - safe command
handleCommand('rm -rf .git');       // BLOCK - protected path
