import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/npm-audit-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-audit-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "npm audit --json",
    argv: ["npm", "audit", "--json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("npm-audit-json parser", () => {
  it("vulnerabilities with advisories → extracts package name, severity, advisory titles", async () => {
    const stdout = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        lodash: {
          name: "lodash",
          severity: "high",
          isDirect: true,
          via: [
            { title: "Command Injection in lodash", severity: "high", url: "https://example.com" },
            { title: "ReDoS in lodash", severity: "moderate", url: "https://example.com" },
          ],
          fixAvailable: true,
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 vulnerability (1 high)");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].file).toBe("lodash");
    expect(result.failures![0].rule).toBe("high");
    expect(result.failures![0].message).toContain("Command Injection");
    expect(result.failures![0].message).toContain("ReDoS");
    // No URLs in output
    expect(result.failures![0].message).not.toContain("https://");
  });

  it("no vulnerabilities → status pass", async () => {
    const stdout = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("no vulnerabilities found");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("multiple severities → correct summary breakdown", async () => {
    const stdout = JSON.stringify({
      vulnerabilities: {
        "pkg-a": { name: "pkg-a", severity: "critical", isDirect: true, via: [{ title: "RCE" }] },
        "pkg-b": { name: "pkg-b", severity: "low", isDirect: false, via: [{ title: "Info leak" }] },
      },
      metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 1, total: 2 } },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.summary).toBe("2 vulnerabilities (1 critical, 1 low)");
    expect(result.failures).toHaveLength(2);
  });
});
