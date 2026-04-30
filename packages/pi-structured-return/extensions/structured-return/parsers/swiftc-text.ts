import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// swiftc format: file:line:col: error: message  (or warning:, note:)
const SWIFT_LINE = /^(.+?):(\d+):\d+:\s+(error|warning):\s+(.+)$/;

const parser: ParserModule = {
  id: "swiftc-text",
  async parse(ctx) {
    // swiftc writes diagnostics (errors, warnings, notes) to stderr.
    const stderr = safeReadFile(ctx.stderrPath).trim();
    if (!stderr) {
      return { tool: "swiftc", status: "pass", summary: "no errors", failures: [], logPath: ctx.logPath };
    }

    const failures: ParsedFailure[] = [];
    const seen = new Set<string>();
    for (const line of stderr.split("\n")) {
      const m = line.match(SWIFT_LINE);
      if (!m) continue;
      const [, file, lineNum, severity, message] = m;
      if (severity !== "error") continue; // skip warnings for now
      const relPath = path.isAbsolute(file) ? path.relative(ctx.cwd, file) : file;
      // Deduplicate: swiftc repeats the same error in source annotation lines
      const id = `${relPath}:${lineNum}:${message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      failures.push({
        id,
        file: relPath,
        line: Number(lineNum),
        message,
      });
    }

    return {
      tool: "swiftc",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} errors` : "no errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
