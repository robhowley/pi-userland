import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

/**
 * Parses minitest's default text output. No flags or reporters required —
 * works with plain `ruby test/my_test.rb` or `bundle exec ruby test/my_test.rb`.
 */
const parser: ParserModule = {
  id: "minitest-text",
  async parse(ctx) {
    const output = safeReadFile(ctx.stdoutPath);

    // "3 runs, 2 assertions, 1 failures, 1 errors, 0 skips"
    const summaryMatch = output.match(/(\d+) runs?, \d+ assertions?, (\d+) failures?, (\d+) errors?, (\d+) skips?/);
    if (!summaryMatch) {
      return { tool: "minitest", status: "error", summary: "no minitest output found", logPath: ctx.logPath };
    }

    const totalRuns = parseInt(summaryMatch[1], 10);
    const failureCount = parseInt(summaryMatch[2], 10);
    const errorCount = parseInt(summaryMatch[3], 10);
    const skipCount = parseInt(summaryMatch[4], 10);
    const totalFailed = failureCount + errorCount;
    const passed = totalRuns - totalFailed - skipCount;

    const failures = parseBlocks(output, ctx.cwd);

    return {
      tool: "minitest",
      status: totalFailed > 0 ? "fail" : "pass",
      summary: totalFailed > 0 ? `${totalFailed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;

function parseBlocks(output: string, cwd: string): ParsedFailure[] {
  const failures: ParsedFailure[] = [];
  const lines = output.split("\n");
  let i = 0;

  while (i < lines.length) {
    const headerMatch = lines[i].match(/^\s+\d+\) (Failure|Error):$/);
    if (!headerMatch) {
      i++;
      continue;
    }

    const type = headerMatch[1];
    i++;

    if (type === "Failure") {
      // "ClassName#method [file:line]:"
      const nameMatch = lines[i]?.match(/^(.+?)\s+\[(.+):(\d+)\]:$/);
      if (nameMatch) {
        const [, id, rawFile, lineStr] = nameMatch;
        i++;
        // Message lines until blank line
        const msgLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== "") {
          msgLines.push(lines[i].trim());
          i++;
        }
        failures.push({
          id,
          file: path.relative(cwd, path.resolve(cwd, rawFile)),
          line: parseInt(lineStr, 10),
          message: msgLines.filter(Boolean).join(" / ") || undefined,
        });
      }
    } else {
      // Error — "ClassName#method:"
      const nameMatch = lines[i]?.match(/^(.+):$/);
      if (nameMatch) {
        const id = nameMatch[1];
        i++;
        // "ExceptionClass: message"
        const exceptionLine = lines[i]?.trim() ?? "";
        const colonIdx = exceptionLine.indexOf(": ");
        const message = colonIdx !== -1 ? exceptionLine.slice(colonIdx + 2) : exceptionLine;
        i++;
        // First backtrace line: "    file.rb:line:in 'method'"
        const backtraceMatch = lines[i]?.match(/^\s+(.+\.rb):(\d+):/);
        failures.push({
          id,
          file: backtraceMatch ? path.relative(cwd, path.resolve(cwd, backtraceMatch[1])) : undefined,
          line: backtraceMatch ? parseInt(backtraceMatch[2], 10) : undefined,
          message: message || undefined,
        });
      }
    }
  }

  return failures;
}
