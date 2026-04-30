import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface ShellCheckItem {
  file: string;
  line: number;
  column: number;
  level: string;
  code: number;
  message: string;
}

const parser: ParserModule = {
  id: "shellcheck-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout || stdout === "[]") {
      return {
        tool: "shellcheck",
        status: "pass",
        summary: "no lint errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let items: ShellCheckItem[];
    try {
      items = JSON.parse(stdout) as ShellCheckItem[];
    } catch {
      return {
        tool: "shellcheck",
        status: "error",
        summary: "failed to parse shellcheck JSON output",
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = items.map((item) => {
      const relPath = path.isAbsolute(item.file) ? path.relative(ctx.cwd, item.file) : item.file;
      return {
        id: `${relPath}:${item.line}:SC${item.code}`,
        file: relPath,
        line: item.line,
        message: item.message,
        rule: `SC${item.code}`,
      };
    });

    return {
      tool: "shellcheck",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
