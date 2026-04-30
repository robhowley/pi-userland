import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface MarkdownlintItem {
  fileName: string;
  lineNumber: number;
  ruleNames: string[];
  ruleDescription: string;
  errorDetail?: string | null;
}

const parser: ParserModule = {
  id: "markdownlint-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return {
        tool: "markdownlint",
        status: "pass",
        summary: "no lint errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let items: MarkdownlintItem[];
    try {
      items = JSON.parse(stdout);
    } catch {
      return {
        tool: "markdownlint",
        status: "error",
        summary: "failed to parse markdownlint JSON output",
        logPath: ctx.logPath,
      };
    }

    if (!Array.isArray(items) || items.length === 0) {
      return {
        tool: "markdownlint",
        status: "pass",
        summary: "no lint errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = items.map((item) => {
      const relPath = path.relative(ctx.cwd, item.fileName);
      // Use the short MD code (first rule name, e.g. "MD041")
      const rule = item.ruleNames[0];
      const message = item.errorDetail ? `${item.ruleDescription}: ${item.errorDetail}` : item.ruleDescription;
      return {
        id: `${relPath}:${item.lineNumber}:${rule}`,
        file: relPath,
        line: item.lineNumber,
        message,
        rule,
      };
    });

    return {
      tool: "markdownlint",
      status: "fail",
      summary: `${failures.length} lint error${failures.length !== 1 ? "s" : ""}`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
