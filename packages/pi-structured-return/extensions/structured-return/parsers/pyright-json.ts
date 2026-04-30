import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface PyrightDiagnostic {
  file: string;
  severity: string;
  message: string;
  range?: { start: { line: number; character: number } };
  rule?: string;
}

interface PyrightOutput {
  generalDiagnostics?: PyrightDiagnostic[];
  summary?: {
    errorCount: number;
    warningCount: number;
    informationCount: number;
  };
}

const parser: ParserModule = {
  id: "pyright-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return {
        tool: "pyright",
        status: "pass",
        summary: "no type errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let output: PyrightOutput;
    try {
      output = JSON.parse(stdout);
    } catch {
      return {
        tool: "pyright",
        status: "error",
        summary: "failed to parse pyright JSON output",
        logPath: ctx.logPath,
      };
    }

    const diagnostics = (output.generalDiagnostics ?? []).filter((d) => d.severity === "error");
    const failures: ParsedFailure[] = diagnostics.map((d) => {
      const relPath = path.relative(ctx.cwd, d.file);
      // pyright uses 0-based lines in JSON
      const line = d.range ? d.range.start.line + 1 : undefined;
      // Collapse multi-line messages (detail line after \n) into a single line
      const message = d.message.split("\n")[0];
      return {
        id: `${relPath}:${line}:${d.rule ?? "error"}`,
        file: relPath,
        line,
        message,
        rule: d.rule,
      };
    });

    const summary = output.summary;
    const parts: string[] = [];
    if (summary) {
      if (summary.errorCount) parts.push(`${summary.errorCount} error${summary.errorCount !== 1 ? "s" : ""}`);
      if (summary.warningCount) parts.push(`${summary.warningCount} warning${summary.warningCount !== 1 ? "s" : ""}`);
    }

    return {
      tool: "pyright",
      status: failures.length > 0 ? "fail" : "pass",
      summary: parts.length > 0 ? parts.join(", ") : "no type errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
