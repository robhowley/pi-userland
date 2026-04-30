import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// [warn] /path/to/file — but not summary lines like "[warn] Code style issues..."
const WARN_LINE = /^\[warn\] (.+)$/;
const SUMMARY_PREFIX = /^Code style issues|^Run Prettier/;

const parser: ParserModule = {
  id: "prettier-text",
  async parse(ctx) {
    const combined = (safeReadFile(ctx.stdoutPath) + "\n" + safeReadFile(ctx.stderrPath)).trim();
    if (!combined) {
      return {
        tool: "prettier",
        status: "pass",
        summary: "all files formatted",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const lines = combined.split("\n");
    const failures: ParsedFailure[] = [];

    for (const line of lines) {
      const warnMatch = line.match(WARN_LINE);
      if (warnMatch && !SUMMARY_PREFIX.test(warnMatch[1])) {
        const relPath = path.relative(ctx.cwd, warnMatch[1]);
        failures.push({
          id: relPath,
          file: relPath,
          message: "needs formatting",
        });
      }
    }

    // All done, no warnings
    if (failures.length === 0 && combined.includes("All matched files use Prettier code style")) {
      return {
        tool: "prettier",
        status: "pass",
        summary: "all files formatted",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const n = failures.length;
    const summary =
      n > 0 ? (n === 1 ? "1 file has formatting issues" : `${n} files have formatting issues`) : "all files formatted";

    return {
      tool: "prettier",
      status: n > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
