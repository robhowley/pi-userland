import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/javac-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "javac-test-"));
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "javac src/TypeCheck.java",
    argv: ["javac", "src/TypeCheck.java"],
    cwd,
    artifactPaths: [],
    stdoutPath: path.join(dir, "stdout"),
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("javac-text parser", () => {
  it("type error with source snippet → strips snippet and caret, extracts file:line and message", async () => {
    const stderr = `/project/src/TypeCheck.java:3: error: incompatible types: String cannot be converted to int
        int x = "hello";
                ^
1 error`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 error");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].file).toBe("src/TypeCheck.java");
    expect(result.failures![0].line).toBe(3);
    expect(result.failures![0].message).toBe("incompatible types: String cannot be converted to int");
  });

  it("cannot find symbol → folds symbol continuation into message", async () => {
    const stderr = `/project/src/App.java:4: error: cannot find symbol
        String y = unknownMethod();
                   ^
  symbol:   method unknownMethod()
  location: class App
1 error`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toBe("cannot find symbol: method unknownMethod()");
    expect(result.failures![0].message).not.toContain("location");
  });

  it("multiple errors → correct count and relative paths", async () => {
    const stderr = `/project/src/A.java:3: error: incompatible types: String cannot be converted to int
        int x = "hello";
                ^
/project/src/B.java:10: error: cannot find symbol
        foo();
        ^
  symbol:   method foo()
  location: class B
2 errors`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/A.java");
    expect(result.failures![1].file).toBe("src/B.java");
  });

  it("empty stderr → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
