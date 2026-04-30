import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface HtmlHintMessage {
  type: string;
  message: string;
  line: number;
  col: number;
  rule: { id: string };
}

interface HtmlHintFile {
  file: string;
  messages: HtmlHintMessage[];
}

const parser: ParserModule = {
  id: "htmlhint-json",
  async parse(ctx) {
    // htmlhint --format json writes JSON to stderr (not stdout), so read stderr first.
    const output = (safeReadFile(ctx.stderrPath) + safeReadFile(ctx.stdoutPath)).trim();
    if (!output) {
      return {
        tool: "htmlhint",
        status: "pass",
        summary: "no lint errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let files: HtmlHintFile[];
    try {
      files = JSON.parse(output);
    } catch {
      return {
        tool: "htmlhint",
        status: "error",
        summary: "failed to parse htmlhint JSON output",
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = [];
    for (const file of files) {
      const relPath = path.relative(ctx.cwd, file.file);
      for (const msg of file.messages) {
        failures.push({
          id: `${relPath}:${msg.line}:${msg.rule.id}`,
          file: relPath,
          line: msg.line,
          message: msg.message,
          rule: msg.rule.id,
        });
      }
    }

    const summary =
      failures.length > 0 ? `${failures.length} lint error${failures.length !== 1 ? "s" : ""}` : "no lint errors";

    return {
      tool: "htmlhint",
      status: failures.length > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
