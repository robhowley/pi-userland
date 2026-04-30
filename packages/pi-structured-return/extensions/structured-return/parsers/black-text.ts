import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

const REFORMAT_LINE = /^would reformat (.+)$/;
const ERROR_FORMAT = /^error: cannot format (.+?): (.+)$/;

const parser: ParserModule = {
  id: "black-text",
  async parse(ctx) {
    const combined = (safeReadFile(ctx.stdoutPath) + "\n" + safeReadFile(ctx.stderrPath)).trim();
    if (!combined) {
      return {
        tool: "black",
        status: "pass",
        summary: "all files formatted",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const lines = combined.split("\n");
    const failures: ParsedFailure[] = [];
    for (const line of lines) {
      const reformatMatch = line.match(REFORMAT_LINE);
      if (reformatMatch) {
        const relPath = path.relative(ctx.cwd, reformatMatch[1]);
        failures.push({
          id: relPath,
          file: relPath,
          message: "would reformat",
        });
        continue;
      }

      const errorMatch = line.match(ERROR_FORMAT);
      if (errorMatch) {
        const relPath = path.relative(ctx.cwd, errorMatch[1]);
        failures.push({
          id: relPath,
          file: relPath,
          message: errorMatch[2],
        });
        continue;
      }
    }

    // If "All done!" and no reformats needed
    if (failures.length === 0 && combined.includes("All done!")) {
      return {
        tool: "black",
        status: "pass",
        summary: "all files formatted",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const summary =
      failures.length > 0
        ? `${failures.length} file${failures.length !== 1 ? "s" : ""} would be reformatted`
        : "all files formatted";

    return {
      tool: "black",
      status: failures.length > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
