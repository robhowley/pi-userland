import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { isToolCallEventType } from '@mariozechner/pi-coding-agent';
import { evaluate, RuleSeverity, Config } from './evaluate.js';
import { logAsk, logBlock, logDebug } from './logger.js';
import { loadConfig } from './config.js';
import { getMatchingRuleIds, BUILTIN_RULES, type RuleDefinition } from './matcher.js';

/**
 * Yolo-seatbelt safety guard extension
 *
 * Intercepts bash tool calls and evaluates commands for safety.
 * Returns { block: true, reason } for dangerous commands.
 *
 * Phase D: All 18 built-in command filters are now user-configurable
 * via rule IDs in the configuration file.
 */

export default function (pi: ExtensionAPI) {
  // Register /yolo-seatbelt-rules slash command
  pi.registerCommand('yolo-seatbelt-rules', {
    description: 'Show currently configured yolo-seatbelt rules and configuration',
    handler: async (_args: string, ctx) => {
      const config = loadConfig();
      const logLevel = config.logLevel || 'none';

      // Format rules with their effective severity, sorted by severity (ALLOW, ASK, BLOCK)
      const severityOrder: Record<RuleSeverity, number> = { allow: 1, ask: 2, block: 3 };
      const ruleList = [...BUILTIN_RULES]
        .map((rule: RuleDefinition) => {
          const effectiveSeverity = (config as Config).rules?.[rule?.id] || rule.defaultSeverity;
          const status =
            effectiveSeverity === 'block'
              ? '🔴 BLOCK'
              : effectiveSeverity === 'ask'
                ? '🟠 ASK'
                : '🟢 ALLOW';
          return {
            severity: effectiveSeverity,
            line: `  ${status}  ${rule?.id}  ${rule.description}`,
          };
        })
        .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
        .map((item) => item.line);

      // Build config info
      const configInfo = [];
      if (logLevel !== 'none') {
        configInfo.push(`  📋 logLevel: ${logLevel}`);
      }

      const ruleCount = Object.keys(config.rules || {}).length;
      if (ruleCount > 0) {
        configInfo.push(`  ⚙️  Custom rules: ${ruleCount}`);
      }

      // Show in a selector
      const items = [
        '--- yolo-seatbelt Configuration ---',
        ...configInfo,
        '',
        '--- Rules ---',
        ...ruleList,
        '',
        '--- Legend ---',
        '🔴 BLOCK - Command is blocked immediately',
        '🟠 ASK - User is prompted for confirmation',
        '🟢 ALLOW - Command proceeds without warning',
      ];

      await ctx.ui.select('yolo-seatbelt Rules', items);
    },
  });

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
    logBlock(command, result?.matchedRule || 'unknown');

    // Handle the decision
    switch (result.decision) {
      case RuleSeverity.BLOCK: {
        return {
          block: true,
          reason: `Blocked by yolo-seatbelt: ${result.matchedRule}`,
        };
      }

      case RuleSeverity.ASK: {
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

      case RuleSeverity.ALLOW: {
        return;
      }
    }

    // Default: allow the command if we get here
    return;
  });
}
