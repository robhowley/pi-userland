import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/mypy-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mypy-test-"));
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stderrPath, stderr);
  // mypy JSON goes to stderr; stdout is empty
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, "");
  return {
    command: "mypy type_check.py --output json",
    argv: ["mypy", "type_check.py", "--output", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("mypy-json parser", () => {
  it("multiple type errors → correct file, line, message, rule, status fail", async () => {
    const stderr = [
      '{"file": "type_check.py", "line": 5, "column": 14, "message": "Incompatible types in assignment (expression has type \\"int\\", variable has type \\"str\\")", "hint": null, "code": "assignment", "severity": "error"}',
      '{"file": "type_check.py", "line": 6, "column": 17, "message": "Argument 1 to \\"add\\" has incompatible type \\"str\\"; expected \\"int\\"", "hint": null, "code": "arg-type", "severity": "error"}',
    ].join("\n");
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 type errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0]).toMatchObject({
      file: "type_check.py",
      line: 5,
      message: 'Incompatible types in assignment (expression has type "int", variable has type "str")',
      rule: "assignment",
    });
    expect(result.failures![1]).toMatchObject({
      file: "type_check.py",
      line: 6,
      message: 'Argument 1 to "add" has incompatible type "str"; expected "int"',
      rule: "arg-type",
    });
  });

  it("no errors (empty stderr) → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("no type errors");
    expect(result.failures).toHaveLength(0);
  });

  it("absolute file paths → relativized to cwd", async () => {
    const stderr =
      '{"file": "/project/src/foo.py", "line": 10, "column": 5, "message": "Need type annotation", "hint": null, "code": "var-annotated", "severity": "error"}';
    const result = await parser.parse(makeCtx(stderr, "/project"));
    expect(result.failures![0].file).toBe("src/foo.py");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("note severity items are skipped as standalone failures", async () => {
    const stderr = [
      '{"file": "foo.py", "line": 5, "column": 1, "message": "Missing return statement", "hint": null, "code": "return", "severity": "error"}',
      '{"file": "foo.py", "line": 5, "column": 1, "message": "See https://mypy.readthedocs.io/...", "hint": null, "code": null, "severity": "note"}',
    ].join("\n");
    const result = await parser.parse(makeCtx(stderr));
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].rule).toBe("return");
  });

  it("notes on the same line as an error are appended to the error message", async () => {
    const stderr = [
      '{"file": "foo.py", "line": 5, "column": 1, "message": "Missing return statement", "hint": null, "code": "return", "severity": "error"}',
      '{"file": "foo.py", "line": 5, "column": 1, "message": "Did you forget to return a value?", "hint": null, "code": null, "severity": "note"}',
    ].join("\n");
    const result = await parser.parse(makeCtx(stderr));
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toBe("Missing return statement (Did you forget to return a value?)");
  });

  it("hint field is included in message when present", async () => {
    const stderr =
      '{"file": "foo.py", "line": 3, "column": 1, "message": "Cannot find module", "hint": "Did you install types-requests?", "code": "import", "severity": "error"}';
    const result = await parser.parse(makeCtx(stderr));
    expect(result.failures![0].message).toBe("Cannot find module (Did you install types-requests?)");
  });

  it("handles non-JSON lines gracefully (e.g. summary text mixed in)", async () => {
    const stderr = [
      '{"file": "foo.py", "line": 1, "column": 1, "message": "Unused import", "hint": null, "code": "unused-import", "severity": "error"}',
      "Found 1 error in 1 file (checked 1 source file)",
    ].join("\n");
    const result = await parser.parse(makeCtx(stderr));
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].rule).toBe("unused-import");
  });
});
