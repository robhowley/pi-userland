import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/bandit-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bandit-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "bandit -f json .",
    argv: ["bandit", "-f", "json", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("bandit-json parser", () => {
  it("multiple issues → correct severity summary, relative paths, rule includes test_id and test_name", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify({
      results: [
        {
          filename: "/project/src/app.py",
          line_number: 1,
          issue_text: "Consider possible security implications associated with the subprocess module.",
          issue_severity: "LOW",
          issue_confidence: "HIGH",
          test_id: "B404",
          test_name: "blacklist",
        },
        {
          filename: "/project/src/app.py",
          line_number: 4,
          issue_text: "subprocess call with shell=True identified, security issue.",
          issue_severity: "HIGH",
          issue_confidence: "HIGH",
          test_id: "B602",
          test_name: "subprocess_popen_with_shell_equals_true",
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 issues (1 high, 1 low)");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/app.py");
    expect(result.failures![0].rule).toBe("B404:blacklist");
    expect(result.failures![1].rule).toBe("B602:subprocess_popen_with_shell_equals_true");
  });

  it("no issues → status pass, empty failures", async () => {
    const stdout = JSON.stringify({ results: [] });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("no security issues");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("single high severity issue → singular 'issue' in summary", async () => {
    const stdout = JSON.stringify({
      results: [
        {
          filename: "/project/danger.py",
          line_number: 10,
          issue_text: "Possible hardcoded password.",
          issue_severity: "HIGH",
          issue_confidence: "MEDIUM",
          test_id: "B105",
          test_name: "hardcoded_password_string",
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 issue (1 high)");
    expect(result.failures).toHaveLength(1);
  });
});
