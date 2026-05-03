import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { isToolCallEventType } from '@mariozechner/pi-coding-agent';
import { evaluate, Decision } from './evaluate.js';
import { logAsk, logBlock, logDebug } from './logger.js';
import { loadConfig } from './config.js';
import { getMatchingRuleIds } from './matcher.js';

/**
 * Yolo-seatbelt safety guard extension
 *
 * Intercepts bash tool calls and evaluates commands for safety.
 * Returns { block: true, reason } for dangerous commands.
 *
 * Phase A: All 18 built-in command filters are now user-configurable
 * via rule IDs in the configuration file.
 */

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    // Only intercept bash tool calls
    if (!isToolCallEventType('bash', event)) {
      return;
    }

    const command = event.input.command;

    // Load config (cached after first load)
    const config = loadConfig();

    // Log matching rule IDs for debugging
    const matchingRules = getMatchingRuleIds(command);
    if (matchingRules.length > 0) {
      logDebug(`Matching rules: ${matchingRules.join(', ')}`);
    }

    // Evaluate the command using the full pipeline with config
    const result = evaluate(command, {
      cwd: ctx.cwd,
      config: config,
    });

    // Log the decision
    logAsk(command);
    logBlock(command, result.matchedRule);

    // Handle the decision
    switch (result.decision) {
      case Decision.BLOCK: {
        // Block the command immediately
        return {
          block: true,
          reason: `Blocked by yolo-seatbelt: ${result.matchedRule}`,
        };
      }

      case Decision.ASK: {
        // Ask user for confirmation
        const confirmed = await ctx.ui.confirm(
          '⚠️ Risky command detected',
          `The command "${command}" matches a safety rule ("${result.matchedRule}").\n\nContinue?`,
        );

        if (!confirmed) {
          return {
            block: true,
            reason: `Blocked by user: ${result.matchedRule}`,
          };
        }
        return;
      }

      case Decision.ALLOW: {
        // Allow the command to proceed normally
        return;
      }
    }

    // Default: allow the command if we get here
    return;
  });
}
