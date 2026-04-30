import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// ERROR: /path/to/file.py Imports are incorrectly sorted and/or formatted.
const ERROR_LINE = /^ERROR: (.+?) Imports are incorrectly sorted/;
const parser: ParserModule = {
  id: "isort-text",
  async parse(ctx) {
    const combined = (safeReadFile(ctx.stdoutPath) + "\n" + safeReadFile(ctx.stderrPath)).trim();
    if (!combined) {
      return {
        tool: "isort",
        status: "pass",
        summary: "all imports sorted",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const lines = combined.split("\n");
    const failures: ParsedFailure[] = [];

    for (const line of lines) {
      const errorMatch = line.match(ERROR_LINE);
      if (errorMatch) {
        const relPath = path.relative(ctx.cwd, errorMatch[1]);
        failures.push({
          id: relPath,
          file: relPath,
          message: "imports are incorrectly sorted",
        });
      }
    }

    if (failures.length === 0 && !combined.includes("ERROR")) {
      return {
        tool: "isort",
        status: "pass",
        summary: "all imports sorted",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const n = failures.length;
    const summary =
      n === 0
        ? "all imports sorted"
        : n === 1
          ? "1 file has incorrectly sorted imports"
          : `${n} files have incorrectly sorted imports`;

    return {
      tool: "isort",
      status: n > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
