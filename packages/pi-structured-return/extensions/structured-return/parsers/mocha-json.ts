import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { extractJsStackLocation, safeReadFile } from "./utils";

interface MochaErr {
  message?: string;
  stack?: string;
  actual?: string;
  expected?: string;
  operator?: string;
  code?: string;
  name?: string;
}

interface MochaTest {
  title: string;
  fullTitle: string;
  file: string;
  err: MochaErr;
}

interface MochaReport {
  stats: { passes: number; failures: number };
  failures: MochaTest[];
}

/** Build a compact failure message. For assertions, include expected/actual. */
function buildMessage(err: MochaErr): string {
  if (err.actual !== undefined && err.expected !== undefined) {
    return `expected ${err.expected}, got ${err.actual}`;
  }
  // First line of message, stripped of newlines
  const firstLine = (err.message ?? "test failed").split("\n")[0].trim();
  return firstLine;
}

const parser: ParserModule = {
  id: "mocha-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return { tool: "mocha", status: "error", summary: "no output", logPath: ctx.logPath };
    }

    let report: MochaReport;
    try {
      report = JSON.parse(stdout) as MochaReport;
    } catch {
      return { tool: "mocha", status: "error", summary: "failed to parse mocha JSON output", logPath: ctx.logPath };
    }

    const failures: ParsedFailure[] = report.failures.map((test) => {
      const loc = extractJsStackLocation(test.err.stack);
      const relFile = loc.file ? path.relative(ctx.cwd, path.resolve(ctx.cwd, loc.file)) : undefined;
      return {
        id: test.fullTitle,
        file: relFile,
        line: loc.line,
        message: buildMessage(test.err),
        rule: test.err.code ?? test.err.name,
      };
    });

    const failed = report.stats.failures;
    const passed = report.stats.passes;

    return {
      tool: "mocha",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
