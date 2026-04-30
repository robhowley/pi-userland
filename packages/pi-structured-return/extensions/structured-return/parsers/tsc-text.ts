import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// tsc --pretty false format: file(line,col): error TSXXXX: message
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

const parser: ParserModule = {
  id: "tsc-text",
  async parse(ctx) {
    const raw = safeReadFile(ctx.stdoutPath).trim();
    if (!raw) {
      return {
        tool: "tsc",
        status: "pass",
        summary: "no type errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = [];
    for (const line of raw.split("\n")) {
      const m = line.match(TSC_LINE);
      if (!m) continue;
      const [, file, lineNum, , code, message] = m;
      const relPath = path.isAbsolute(file) ? path.relative(ctx.cwd, file) : file;
      failures.push({
        id: `${relPath}:${lineNum}:${code}`,
        file: relPath,
        line: Number(lineNum),
        message,
        rule: code,
      });
    }

    return {
      tool: "tsc",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} type errors` : "no type errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
