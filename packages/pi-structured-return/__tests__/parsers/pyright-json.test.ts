import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/pyright-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyright-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "pyright --outputjson .",
    argv: ["pyright", "--outputjson", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("pyright-json parser", () => {
  it("single error → correct relative path, 1-based line, rule mapped, status fail", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify({
      version: "1.1.408",
      generalDiagnostics: [
        {
          file: "/project/src/app.py",
          severity: "error",
          message: 'Type "str" is not assignable to declared type "int"\n  "str" is not assignable to "int"',
          range: { start: { line: 3, character: 14 }, end: { line: 3, character: 28 } },
          rule: "reportAssignmentType",
        },
      ],
      summary: { filesAnalyzed: 1, errorCount: 1, warningCount: 0, informationCount: 0 },
    });
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 error");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].file).toBe("src/app.py");
    expect(result.failures![0].line).toBe(4); // 0-based → 1-based
    expect(result.failures![0].rule).toBe("reportAssignmentType");
    expect(result.failures![0].message).not.toContain("\n");
  });

  it("multiple errors across files → correct count and paths", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify({
      generalDiagnostics: [
        {
          file: "/project/a.py",
          severity: "error",
          message: 'Cannot access attribute "foo" for class "Bar"',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          rule: "reportAttributeAccessIssue",
        },
        {
          file: "/project/b.py",
          severity: "error",
          message: 'Argument missing for parameter "x"',
          range: { start: { line: 9, character: 0 }, end: { line: 9, character: 10 } },
          rule: "reportCallIssue",
        },
      ],
      summary: { filesAnalyzed: 2, errorCount: 2, warningCount: 0, informationCount: 0 },
    });
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("a.py");
    expect(result.failures![1].file).toBe("b.py");
  });

  it("warnings only (no errors) → status pass, empty failures", async () => {
    const stdout = JSON.stringify({
      generalDiagnostics: [
        {
          file: "/project/c.py",
          severity: "warning",
          message: 'Import "os" is not accessed',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
          rule: "reportUnusedImport",
        },
      ],
      summary: { filesAnalyzed: 1, errorCount: 0, warningCount: 1, informationCount: 0 },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 warning");
    expect(result.failures).toHaveLength(0);
  });

  it("no diagnostics → status pass", async () => {
    const stdout = JSON.stringify({
      generalDiagnostics: [],
      summary: { filesAnalyzed: 1, errorCount: 0, warningCount: 0, informationCount: 0 },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
