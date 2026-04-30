import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// Error: Parse error on line N:
const ERROR_HEADER = /^Error: Parse error on line (\d+):$/;
// Expecting 'X', got 'Y'
const EXPECTING_LINE = /^(Expecting .+)$/;

const parser: ParserModule = {
  id: "jsonlint-text",
  async parse(ctx) {
    const combined = (safeReadFile(ctx.stdoutPath) + "\n" + safeReadFile(ctx.stderrPath)).trim();
    if (!combined) {
      return {
        tool: "jsonlint",
        status: "pass",
        summary: "valid JSON",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    // Derive filename from argv — use last non-flag arg since earlier positional
    // args may be flag values (e.g. npx --yes jsonlint file.json).
    const file = ctx.argv.filter((a) => !a.startsWith("-") && a !== "jsonlint" && a !== "npx").pop() ?? "input";

    const lines = combined.split("\n");
    const failures: ParsedFailure[] = [];
    let line: number | undefined;
    let message = "";

    for (const l of lines) {
      const headerMatch = l.match(ERROR_HEADER);
      if (headerMatch) {
        line = parseInt(headerMatch[1], 10);
        continue;
      }
      const expectMatch = l.match(EXPECTING_LINE);
      if (expectMatch) {
        message = expectMatch[1];
        continue;
      }
    }

    if (line !== undefined) {
      failures.push({
        id: `${file}:${line}`,
        file,
        line,
        message: message || "parse error",
      });
    }

    return {
      tool: "jsonlint",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? "parse error" : "valid JSON",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
