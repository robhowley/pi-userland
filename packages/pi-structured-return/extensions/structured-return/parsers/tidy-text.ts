import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// line N column N - Warning/Error: message
const ISSUE_LINE = /^line (\d+) column \d+ - (Warning|Error): (.+)$/;
// Summary: N warnings, N errors were found!
const SUMMARY_LINE = /^(\d+) warnings?, (\d+) errors? were found/;

const parser: ParserModule = {
  id: "tidy-text",
  async parse(ctx) {
    const stderr = safeReadFile(ctx.stderrPath).trim();
    if (!stderr) {
      return {
        tool: "tidy",
        status: "pass",
        summary: "no issues found",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const lines = stderr.split("\n");
    const failures: ParsedFailure[] = [];
    let warnings = 0;
    let errors = 0;

    // Derive filename from command argv — tidy doesn't include filenames in output.
    // Use last non-flag arg since flags like `-indent auto` have value arguments.
    const file = ctx.argv.filter((a) => !a.startsWith("-") && a !== "tidy").pop() ?? "input";

    for (const line of lines) {
      const issueMatch = line.match(ISSUE_LINE);
      if (issueMatch) {
        const [, lineNum, level, message] = issueMatch;
        failures.push({
          id: `${file}:${lineNum}:${message}`,
          file,
          line: parseInt(lineNum, 10),
          message,
          rule: level.toLowerCase(),
        });
        continue;
      }
      const sumMatch = line.match(SUMMARY_LINE);
      if (sumMatch) {
        warnings = parseInt(sumMatch[1], 10);
        errors = parseInt(sumMatch[2], 10);
      }
    }

    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} error${errors !== 1 ? "s" : ""}`);
    if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? "s" : ""}`);
    const summary = parts.join(", ") || "no issues found";

    return {
      tool: "tidy",
      status: errors > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
