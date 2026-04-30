import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/pylint-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pylint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "pylint lint_check.py --output-format=json",
    argv: ["pylint", "lint_check.py", "--output-format=json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("pylint-json parser", () => {
  it("multiple lint errors → correct file, line, message, rule, status fail", async () => {
    const stdout = JSON.stringify([
      {
        type: "warning",
        module: "lint_check",
        obj: "process_order",
        line: 5,
        column: 4,
        endLine: 5,
        endColumn: 12,
        path: "lint_check.py",
        symbol: "unused-variable",
        message: "Unused variable 'discount'",
        "message-id": "W0612",
      },
      {
        type: "warning",
        module: "lint_check",
        obj: "",
        line: 1,
        column: 0,
        endLine: 1,
        endColumn: 9,
        path: "lint_check.py",
        symbol: "unused-import",
        message: "Unused import os",
        "message-id": "W0611",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0]).toMatchObject({
      file: "lint_check.py",
      line: 5,
      message: "Unused variable 'discount'",
      rule: "W0612(unused-variable)",
    });
    expect(result.failures![1]).toMatchObject({
      file: "lint_check.py",
      line: 1,
      message: "Unused import os",
      rule: "W0611(unused-import)",
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
        type: "convention",
        module: "foo",
        obj: "",
        line: 1,
        column: 0,
        path: "/project/src/foo.py",
        symbol: "missing-module-docstring",
        message: "Missing module docstring",
        "message-id": "C0114",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("src/foo.py");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("rule includes both message-id and symbol", async () => {
    const stdout = JSON.stringify([
      {
        type: "convention",
        module: "foo",
        obj: "",
        line: 1,
        column: 0,
        path: "foo.py",
        symbol: "line-too-long",
        message: "Line too long (120/100)",
        "message-id": "C0301",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].rule).toBe("C0301(line-too-long)");
  });
});
