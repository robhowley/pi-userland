import path from "node:path";
import type { ParserModule } from "../types";
import { safeReadFile } from "./utils";

interface VitestAssertionResult {
  fullName: string;
  status: "passed" | "failed";
  failureMessages: string[];
}

interface VitestTestResult {
  name: string;
  status: "passed" | "failed";
  assertionResults: VitestAssertionResult[];
}

interface VitestReport {
  numPassedTests: number;
  numFailedTests: number;
  testResults: VitestTestResult[];
}

const parser: ParserModule = {
  id: "vitest-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    const report = stdout ? (JSON.parse(stdout) as VitestReport) : null;
    if (!report) {
      return {
        tool: "vitest",
        status: "error",
        summary: "no output",
        logPath: ctx.logPath,
      };
    }

    const failures = report.testResults.flatMap((suite) =>
      suite.assertionResults
        .filter((t) => t.status === "failed")
        .map((t) => ({
          id: t.fullName,
          file: path.relative(ctx.cwd, suite.name),
          message: t.failureMessages[0]?.split("\n")[0] ?? "test failed",
        }))
    );

    const failed = report.numFailedTests;
    const passed = report.numPassedTests;

    return {
      tool: "vitest",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
