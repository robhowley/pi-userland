import path from "node:path";
import type { ParserModule } from "../types";
import { safeReadFile } from "./utils";

const parser: ParserModule = {
  id: "eslint-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    const files = stdout ? JSON.parse(stdout) : [];
    const failures = [] as Array<{ id: string; file?: string; line?: number; message?: string; rule?: string }>;
    for (const file of Array.isArray(files) ? files : []) {
      const relPath = path.relative(ctx.cwd, file.filePath);
      for (const msg of file.messages ?? []) {
        failures.push({
          id: `${relPath}:${msg.line}:${msg.ruleId ?? "unknown"}`,
          file: relPath,
          line: msg.line,
          message: msg.message,
          rule: msg.ruleId ?? undefined,
        });
      }
    }
    return {
      tool: "eslint",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
