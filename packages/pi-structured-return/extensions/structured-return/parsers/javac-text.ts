import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

const ERROR_LINE = /^(.+?):(\d+): error: (.+)$/;
const SYMBOL_LINE = /^\s+symbol:\s+(.+)$/;
const SUMMARY_LINE = /^(\d+) errors?$/;
const CARET_LINE = /^\s+\^/;
const SOURCE_SNIPPET = /^\s{8,}\S/;

const parser: ParserModule = {
  id: "javac-text",
  async parse(ctx) {
    const stderr = safeReadFile(ctx.stderrPath).trim();
    if (!stderr) {
      return {
        tool: "javac",
        status: "pass",
        summary: "compilation successful",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const lines = stderr.split("\n");
    const failures: ParsedFailure[] = [];
    let summaryLine = "";

    for (let i = 0; i < lines.length; i++) {
      const errorMatch = lines[i].match(ERROR_LINE);
      if (errorMatch) {
        const [, filePath, lineNum, message] = errorMatch;
        const relPath = path.relative(ctx.cwd, filePath);
        let fullMessage = message;

        // Look ahead past source snippet and caret for symbol/location continuation lines
        for (let j = i + 1; j < lines.length; j++) {
          const symbolMatch = lines[j].match(SYMBOL_LINE);
          if (symbolMatch) {
            fullMessage += `: ${symbolMatch[1]}`;
          } else if (/^\s+location:/.test(lines[j])) {
            // Skip location lines — they repeat the class name which is in the file path
            continue;
          } else if (CARET_LINE.test(lines[j]) || SOURCE_SNIPPET.test(lines[j])) {
            // Caret indicator or deeply-indented source snippet — skip
            continue;
          } else {
            break;
          }
        }

        failures.push({
          id: `${relPath}:${lineNum}`,
          file: relPath,
          line: parseInt(lineNum, 10),
          message: fullMessage,
        });
        continue;
      }

      const sumMatch = lines[i].match(SUMMARY_LINE);
      if (sumMatch) {
        summaryLine = lines[i];
      }
    }

    const summary =
      summaryLine ||
      (failures.length > 0 ? `${failures.length} error${failures.length !== 1 ? "s" : ""}` : "compilation successful");

    return {
      tool: "javac",
      status: failures.length > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
