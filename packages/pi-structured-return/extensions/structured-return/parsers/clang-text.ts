import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// Clang/GCC error format: file:line:col: error: message [-Wflag]
const ERROR_LINE = /^(.+?):(\d+):\d+: (error|fatal error): (.+?)(\s+\[-.+\])?$/;
const SUMMARY_LINE = /^(\d+) errors? generated/;

const parser: ParserModule = {
  id: "clang-text",
  async parse(ctx) {
    const stderr = safeReadFile(ctx.stderrPath).trim();
    if (!stderr) {
      return {
        tool: "clang",
        status: "pass",
        summary: "compilation successful",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const lines = stderr.split("\n");
    const failures: ParsedFailure[] = [];
    let summaryLine = "";

    for (const line of lines) {
      const errorMatch = line.match(ERROR_LINE);
      if (errorMatch) {
        const [, filePath, lineNum, , message, flag] = errorMatch;
        const relPath = path.relative(ctx.cwd, filePath);
        failures.push({
          id: `${relPath}:${lineNum}`,
          file: relPath,
          line: parseInt(lineNum, 10),
          message,
          rule: flag?.trim().replace(/^\[/, "").replace(/\]$/, ""),
        });
        continue;
      }
      const sumMatch = line.match(SUMMARY_LINE);
      if (sumMatch) summaryLine = line;
    }

    const summary =
      summaryLine ||
      (failures.length > 0 ? `${failures.length} error${failures.length !== 1 ? "s" : ""}` : "compilation successful");

    return {
      tool: "clang",
      status: failures.length > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
