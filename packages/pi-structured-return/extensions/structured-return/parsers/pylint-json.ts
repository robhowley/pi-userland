import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface PylintItem {
  type: string;
  module: string;
  obj: string;
  line: number;
  column: number;
  path: string;
  symbol: string;
  message: string;
  "message-id": string;
}

const parser: ParserModule = {
  id: "pylint-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout || stdout === "[]") {
      return {
        tool: "pylint",
        status: "pass",
        summary: "no lint errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let items: PylintItem[];
    try {
      items = JSON.parse(stdout) as PylintItem[];
    } catch {
      return {
        tool: "pylint",
        status: "error",
        summary: "failed to parse pylint JSON output",
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = items.map((item) => {
      const relPath = path.isAbsolute(item.path) ? path.relative(ctx.cwd, item.path) : item.path;
      return {
        id: `${relPath}:${item.line}:${item["message-id"]}`,
        file: relPath,
        line: item.line,
        message: item.message,
        rule: `${item["message-id"]}(${item.symbol})`,
      };
    });

    return {
      tool: "pylint",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
