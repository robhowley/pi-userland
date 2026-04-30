import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface BanditResult {
  filename: string;
  line_number: number;
  issue_text: string;
  issue_severity: string;
  test_id: string;
  test_name: string;
}

interface BanditOutput {
  results?: BanditResult[];
}

const parser: ParserModule = {
  id: "bandit-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return {
        tool: "bandit",
        status: "pass",
        summary: "no security issues",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let output: BanditOutput;
    try {
      output = JSON.parse(stdout);
    } catch {
      return {
        tool: "bandit",
        status: "error",
        summary: "failed to parse bandit JSON output",
        logPath: ctx.logPath,
      };
    }

    const results = output.results ?? [];
    const failures: ParsedFailure[] = results.map((r) => {
      const relPath = path.relative(ctx.cwd, r.filename);
      return {
        id: `${relPath}:${r.line_number}:${r.test_id}`,
        file: relPath,
        line: r.line_number,
        message: r.issue_text,
        rule: `${r.test_id}:${r.test_name}`,
      };
    });

    const bySeverity: Record<string, number> = {};
    for (const r of results) {
      const sev = r.issue_severity.toLowerCase();
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }
    const sevParts = ["high", "medium", "low"].filter((s) => bySeverity[s]).map((s) => `${bySeverity[s]} ${s}`);

    const summary =
      results.length > 0
        ? `${results.length} issue${results.length !== 1 ? "s" : ""} (${sevParts.join(", ")})`
        : "no security issues";

    return {
      tool: "bandit",
      status: failures.length > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
