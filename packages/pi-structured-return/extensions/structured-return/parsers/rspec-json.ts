import path from "node:path";
import type { ParserModule } from "../types";
import { safeReadFile } from "./utils";

interface RSpecException {
  class: string;
  message: string;
  backtrace: string[];
}

interface RSpecExample {
  id: string;
  full_description: string;
  status: "passed" | "failed" | "pending";
  file_path: string;
  line_number: number;
  exception?: RSpecException;
}

interface RSpecReport {
  examples: RSpecExample[];
  summary: {
    example_count: number;
    failure_count: number;
    pending_count: number;
  };
}

/** Take all non-empty lines before the first blank line — captures expected/got pairs intact. */
function firstParagraph(message: string): string {
  const lines = message.trim().split("\n");
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") break;
    paragraph.push(line.trim());
  }
  return paragraph.join(" / ");
}

const parser: ParserModule = {
  id: "rspec-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    const report = stdout ? (JSON.parse(stdout) as RSpecReport) : null;
    if (!report) {
      return {
        tool: "rspec",
        status: "error",
        summary: "no output",
        logPath: ctx.logPath,
      };
    }

    const failures = report.examples
      .filter((e) => e.status === "failed")
      .map((e) => ({
        id: e.id,
        file: path.relative(ctx.cwd, path.resolve(ctx.cwd, e.file_path)),
        line: e.line_number,
        message: e.exception ? firstParagraph(e.exception.message) : e.full_description,
      }));

    const failed = report.summary.failure_count;
    const passed = report.summary.example_count - failed - report.summary.pending_count;

    return {
      tool: "rspec",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
