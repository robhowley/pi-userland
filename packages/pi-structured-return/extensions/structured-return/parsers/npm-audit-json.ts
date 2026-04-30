import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface NpmAuditVia {
  title?: string;
  severity?: string;
  url?: string;
  name?: string;
}

interface NpmAuditVuln {
  name: string;
  severity: string;
  isDirect: boolean;
  via: Array<NpmAuditVia | string>;
  fixAvailable?: boolean | { name: string; version: string };
}

interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVuln>;
  metadata?: {
    vulnerabilities?: Record<string, number>;
  };
}

const parser: ParserModule = {
  id: "npm-audit-json",
  async parse(ctx) {
    const stdout = safeReadFile(ctx.stdoutPath).trim();
    if (!stdout) {
      return {
        tool: "npm audit",
        status: "pass",
        summary: "no vulnerabilities found",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let report: NpmAuditReport;
    try {
      report = JSON.parse(stdout);
    } catch {
      return {
        tool: "npm audit",
        status: "error",
        summary: "failed to parse npm audit JSON output",
        logPath: ctx.logPath,
      };
    }

    const vulns = report.vulnerabilities ?? {};
    const failures: ParsedFailure[] = [];

    for (const [pkg, vuln] of Object.entries(vulns)) {
      // Extract advisory titles from 'via' (skip string refs to other packages)
      const titles = vuln.via.filter((v): v is NpmAuditVia => typeof v !== "string" && !!v.title).map((v) => v.title!);
      const message = titles.length > 0 ? titles.join("; ") : `${vuln.severity} severity vulnerability`;
      failures.push({
        id: pkg,
        file: pkg,
        message,
        rule: vuln.severity,
      });
    }

    // Build severity summary from metadata
    const meta = report.metadata?.vulnerabilities ?? {};
    const sevParts = ["critical", "high", "moderate", "low", "info"]
      .filter((s) => meta[s])
      .map((s) => `${meta[s]} ${s}`);
    const total = meta.total ?? failures.length;
    const summary =
      total > 0
        ? `${total} vulnerabilit${total !== 1 ? "ies" : "y"} (${sevParts.join(", ")})`
        : "no vulnerabilities found";

    return {
      tool: "npm audit",
      status: total > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
