import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { evaluate } from "./evaluate.js";
import { logAsk, logBlock } from "./logger.js";

/**
 * Yolo-seatbelt safety guard extension
 * 
 * Intercepts bash tool calls and evaluates commands for safety.
 * Returns { block: true, reason } for dangerous commands.
 */

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Only intercept bash tool calls
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const command = event.input.command;

    // Evaluate the command using the full pipeline
    const result = evaluate(command, {
      cwd: ctx.cwd,
      config: { outsideWorkspace: "ask", logLevel: "none" },
    });

    // Log the decision
    logAsk(command);
    logBlock(command, result.matchedRule);

    // Handle the decision
    switch (result.decision) {
      case "BLOCK": {
        // Block the command immediately
        return {
          block: true,
          reason: `Blocked by yolo-seatbelt: ${result.matchedRule}`,
        };
      }

      case "ASK": {
        // Ask user for confirmation
        const confirmed = await ctx.ui.confirm(
          "⚠️ Risky command detected",
          `The command "${command}" matches a safety rule ("${result.matchedRule}").\n\nContinue?`
        );

        if (!confirmed) {
          return {
            block: true,
            reason: `Blocked by user: ${result.matchedRule}`,
          };
        }
        return;
      }

      case "ALLOW": {
        // Allow the command to proceed normally
        return;
      }
    }
  });
}
