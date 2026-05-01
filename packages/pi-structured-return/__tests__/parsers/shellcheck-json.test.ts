import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/shellcheck-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shellcheck-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "shellcheck lint_check.sh --format=json",
    argv: ["shellcheck", "lint_check.sh", "--format=json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("shellcheck-json parser", () => {
  it("multiple lint errors → correct file, line, message, rule, status fail", async () => {
    const stdout = JSON.stringify([
      {
        file: "lint_check.sh",
        line: 4,
        endLine: 4,
        column: 6,
        endColumn: 15,
        level: "info",
        code: 2086,
        message: "Double quote to prevent globbing and word splitting.",
        fix: null,
      },
      {
        file: "lint_check.sh",
        line: 6,
        endLine: 6,
        column: 10,
        endColumn: 21,
        level: "error",
        code: 2045,
        message: "Iterating over ls output is fragile. Use globs.",
        fix: null,
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0]).toMatchObject({
      file: "lint_check.sh",
      line: 4,
      message: "Double quote to prevent globbing and word splitting.",
      rule: "SC2086",
    });
    expect(result.failures![1]).toMatchObject({
      file: "lint_check.sh",
      line: 6,
      message: "Iterating over ls output is fragile. Use globs.",
      rule: "SC2045",
    });
  });

  it("no errors (empty array) → status pass", async () => {
    const result = await parser.parse(makeCtx("[]"));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("no lint errors");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("absolute file paths → relativized to cwd", async () => {
    const stdout = JSON.stringify([
      {
        file: "/project/scripts/deploy.sh",
        line: 10,
        column: 5,
        level: "warning",
        code: 2034,
        message: "foo appears unused.",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("scripts/deploy.sh");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("rule code is prefixed with SC", async () => {
    const stdout = JSON.stringify([
      {
        file: "test.sh",
        line: 1,
        column: 1,
        level: "info",
        code: 2035,
        message: "Use ./*glob* or -- *glob* so names with dashes won't become options.",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].rule).toBe("SC2035");
  });
});
