import path from "node:path";
import type { ParserModule } from "../types";
import { safeReadFile } from "./utils";

interface RuffItem {
  filename: string;
  code: string;
  message: string;
  location?: { row: number };
}

const parser: ParserModule = {
  id: "ruff-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    const items = stdout ? (JSON.parse(stdout) as RuffItem[]) : [];
    const failures = (Array.isArray(items) ? items : []).map((item) => {
      const relPath = path.relative(ctx.cwd, item.filename);
      return {
        id: `${relPath}:${item.location?.row}:${item.code}`,
        file: relPath,
        line: item.location?.row,
        message: item.message,
        rule: item.code,
      };
    });
    return {
      tool: "ruff",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
