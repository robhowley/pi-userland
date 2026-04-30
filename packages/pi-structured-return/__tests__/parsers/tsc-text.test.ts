import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/tsc-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsc-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "tsc --noEmit --pretty false",
    argv: ["tsc", "--noEmit", "--pretty", "false"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("tsc-text parser", () => {
  it("multiple type errors → correct file, line, message, rule, status fail", async () => {
    const stdout = [
      "type_check.ts(5,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "type_check.ts(6,27): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    ].join("\n");
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 type errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0]).toMatchObject({
      file: "type_check.ts",
      line: 5,
      message: "Type 'number' is not assignable to type 'string'.",
      rule: "TS2322",
    });
    expect(result.failures![1]).toMatchObject({
      file: "type_check.ts",
      line: 6,
      message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
      rule: "TS2345",
    });
  });

  it("no errors (empty stdout) → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("no type errors");
    expect(result.failures).toHaveLength(0);
  });

  it("absolute file paths → relativized to cwd", async () => {
    const stdout = "/project/src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.";
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("src/foo.ts");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("errors across multiple files", async () => {
    const stdout = [
      "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
      "src/b.ts(5,3): error TS2551: Property 'baz' does not exist on type 'Bar'.",
    ].join("\n");
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/a.ts");
    expect(result.failures![1].file).toBe("src/b.ts");
  });

  it("skips non-error lines (e.g. Found N errors)", async () => {
    const stdout = [
      "type_check.ts(5,7): error TS2322: Type 'number' is not assignable to type 'string'.",
      "",
      "Found 1 error in type_check.ts:5",
    ].join("\n");
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures).toHaveLength(1);
  });
});
