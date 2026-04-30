import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface ValeAlert {
  Line: number;
  Message: string;
  Severity: string;
  Check: string;
}

const parser: ParserModule = {
  id: "vale-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return {
        tool: "vale",
        status: "pass",
        summary: "no prose issues",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let output: Record<string, ValeAlert[]>;
    try {
      output = JSON.parse(stdout);
    } catch {
      return {
        tool: "vale",
        status: "error",
        summary: "failed to parse vale JSON output",
        logPath: ctx.logPath,
      };
    }

    const failures: ParsedFailure[] = [];
    const bySeverity: Record<string, number> = {};

    for (const [filePath, alerts] of Object.entries(output)) {
      const relPath = path.relative(ctx.cwd, filePath);
      for (const alert of alerts) {
        const sev = alert.Severity.toLowerCase();
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
        failures.push({
          id: `${relPath}:${alert.Line}:${alert.Check}`,
          file: relPath,
          line: alert.Line,
          message: alert.Message,
          rule: alert.Check,
        });
      }
    }

    if (failures.length === 0) {
      return {
        tool: "vale",
        status: "pass",
        summary: "no prose issues",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const parts = ["error", "warning", "suggestion"]
      .filter((s) => bySeverity[s])
      .map((s) => `${bySeverity[s]} ${s}${bySeverity[s] !== 1 ? "s" : ""}`);

    return {
      tool: "vale",
      status: bySeverity["error"] ? "fail" : "pass",
      summary: parts.join(", "),
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
