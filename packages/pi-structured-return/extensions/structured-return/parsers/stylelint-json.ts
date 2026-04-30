import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface StylelintWarning {
  line: number;
  column: number;
  rule: string;
  severity: string;
  text: string;
}

interface StylelintResult {
  source: string;
  warnings: StylelintWarning[];
}

const parser: ParserModule = {
  id: "stylelint-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout || stdout === "[]") {
      return { tool: "stylelint", status: "pass", summary: "no lint errors", failures: [], logPath: ctx.logPath };
    }

    let results: StylelintResult[];
    try {
      results = JSON.parse(stdout) as StylelintResult[];
    } catch {
      return {
        tool: "stylelint",
        status: "error",
        summary: "failed to parse stylelint JSON output",
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = [];
    for (const result of results) {
      const relPath = path.isAbsolute(result.source) ? path.relative(ctx.cwd, result.source) : result.source;
      for (const w of result.warnings) {
        // Strip the trailing " (rule-name)" from text, but only if the
        // parenthesized content matches the actual rule name. Avoids
        // over-stripping when the message itself ends with parens
        // (e.g. CSS values like "calc(100% - 10px)").
        const suffix = ` (${w.rule})`;
        const msg = w.text.endsWith(suffix) ? w.text.slice(0, -suffix.length) : w.text;
        failures.push({
          id: `${relPath}:${w.line}:${w.rule}`,
          file: relPath,
          line: w.line,
          message: msg,
          rule: w.rule,
        });
      }
    }

    return {
      tool: "stylelint",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
