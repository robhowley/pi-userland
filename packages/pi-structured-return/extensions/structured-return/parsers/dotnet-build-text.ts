import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// MSBuild error format: file(line,col): error CODE: message [project]
const ERROR_LINE = /^(.+?)\((\d+),\d+\): error (\w+): (.+?)(?:\s+\[.+\])?$/;

const parser: ParserModule = {
  id: "dotnet-build-text",
  async parse(ctx) {
    const combined = safeReadFile(ctx.stdoutPath) + safeReadFile(ctx.stderrPath);
    const lines = combined.split("\n");

    // Deduplicate — MSBuild prints errors twice (inline + summary)
    const seen = new Set<string>();
    const failures: ParsedFailure[] = [];

    for (const line of lines) {
      const match = line.trim().match(ERROR_LINE);
      if (!match) continue;
      const [, filePath, lineNum, code, message] = match;
      const relPath = path.relative(ctx.cwd, filePath);
      const key = `${relPath}:${lineNum}:${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({
        id: key,
        file: relPath,
        line: parseInt(lineNum, 10),
        message,
        rule: code,
      });
    }

    const summary =
      failures.length > 0 ? `${failures.length} error${failures.length !== 1 ? "s" : ""}` : "build succeeded";

    return {
      tool: "dotnet build",
      status: failures.length > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
