import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface RubocopOffense {
  severity: string;
  message: string;
  cop_name: string;
  location: { line: number; column: number };
}

interface RubocopFile {
  path: string;
  offenses: RubocopOffense[];
}

interface RubocopOutput {
  files: RubocopFile[];
  summary: { offense_count: number };
}

const parser: ParserModule = {
  id: "rubocop-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return { tool: "rubocop", status: "pass", summary: "no lint errors", failures: [], logPath: ctx.logPath };
    }

    let data: RubocopOutput;
    try {
      data = JSON.parse(stdout) as RubocopOutput;
    } catch {
      return { tool: "rubocop", status: "error", summary: "failed to parse rubocop JSON output", logPath: ctx.logPath };
    }

    const failures: ParsedFailure[] = [];
    for (const file of data.files) {
      const relPath = path.isAbsolute(file.path) ? path.relative(ctx.cwd, file.path) : file.path;
      for (const o of file.offenses) {
        // Strip the "CopName: " prefix from the message if present.
        // Escape special regex chars in cop_name (e.g. "." in Style/Foo.Bar).
        const escapedCop = o.cop_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const msg = o.message.replace(new RegExp(`^${escapedCop}:\\s*`), "");
        failures.push({
          id: `${relPath}:${o.location.line}:${o.cop_name}`,
          file: relPath,
          line: o.location.line,
          message: msg,
          rule: o.cop_name,
        });
      }
    }

    return {
      tool: "rubocop",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} lint errors` : "no lint errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
