import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface HadolintItem {
  code: string;
  column: number;
  file: string;
  level: string;
  line: number;
  message: string;
}

const parser: ParserModule = {
  id: "hadolint-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout || stdout === "[]") {
      return { tool: "hadolint", status: "pass", summary: "no lint errors", failures: [], logPath: ctx.logPath };
    }

    let items: HadolintItem[];
    try {
      items = JSON.parse(stdout) as HadolintItem[];
    } catch {
      return {
        tool: "hadolint",
        status: "error",
        summary: "failed to parse hadolint JSON output",
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = items.map((item) => {
      const relPath = path.isAbsolute(item.file) ? path.relative(ctx.cwd, item.file) : item.file;
      return {
        id: `${relPath}:${item.line}:${item.code}`,
        file: relPath,
        line: item.line,
        message: item.message,
        rule: item.code,
      };
    });

    return {
      tool: "hadolint",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
