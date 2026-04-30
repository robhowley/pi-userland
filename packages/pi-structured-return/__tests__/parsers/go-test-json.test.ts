import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/go-test-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gotest-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "go test -json ./...",
    argv: ["go", "test", "-json", "./..."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

function ndjson(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("go-test-json parser", () => {
  it("assertion failure → file:line and message from t.Errorf output", async () => {
    const stdout = ndjson(
      { Action: "run", Package: "math-test", Test: "TestAdd" },
      { Action: "output", Package: "math-test", Test: "TestAdd", Output: "=== RUN   TestAdd\n" },
      { Action: "output", Package: "math-test", Test: "TestAdd", Output: "--- PASS: TestAdd (0.00s)\n" },
      { Action: "pass", Package: "math-test", Test: "TestAdd" },
      { Action: "run", Package: "math-test", Test: "TestMultiply" },
      { Action: "output", Package: "math-test", Test: "TestMultiply", Output: "=== RUN   TestMultiply\n" },
      {
        Action: "output",
        Package: "math-test",
        Test: "TestMultiply",
        Output: "    math_test.go:14: expected 99, got 12\n",
      },
      { Action: "output", Package: "math-test", Test: "TestMultiply", Output: "--- FAIL: TestMultiply (0.00s)\n" },
      { Action: "fail", Package: "math-test", Test: "TestMultiply" },
      { Action: "fail", Package: "math-test", Elapsed: 0.1 }
    );
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 failed, 1 passed");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0]).toMatchObject({
      file: "math_test.go",
      line: 14,
      message: "expected 99, got 12",
    });
  });

  it("panic → message and user-code file:line from stack trace", async () => {
    const stdout = ndjson(
      { Action: "run", Package: "math-test", Test: "TestDoesNotPanic" },
      { Action: "output", Package: "math-test", Test: "TestDoesNotPanic", Output: "=== RUN   TestDoesNotPanic\n" },
      {
        Action: "output",
        Package: "math-test",
        Test: "TestDoesNotPanic",
        Output: "--- FAIL: TestDoesNotPanic (0.00s)\n",
      },
      {
        Action: "output",
        Package: "math-test",
        Test: "TestDoesNotPanic",
        Output: "panic: runtime error: invalid memory address or nil pointer dereference [recovered, repanicked]\n",
      },
      { Action: "output", Package: "math-test", Test: "TestDoesNotPanic", Output: "goroutine 23 [running]:\n" },
      {
        Action: "output",
        Package: "math-test",
        Test: "TestDoesNotPanic",
        Output: "testing.tRunner.func1.2({0x1003f2be0, 0x10043cec0})\n",
      },
      {
        Action: "output",
        Package: "math-test",
        Test: "TestDoesNotPanic",
        Output: "\t/usr/local/go/src/testing/testing.go:1974 +0x1a0\n",
      },
      {
        Action: "output",
        Package: "math-test",
        Test: "TestDoesNotPanic",
        Output: "math-test.TestDoesNotPanic(0x123)\n",
      },
      { Action: "output", Package: "math-test", Test: "TestDoesNotPanic", Output: "\t/project/math_test.go:20 +0x4\n" },
      { Action: "fail", Package: "math-test", Test: "TestDoesNotPanic" },
      { Action: "fail", Package: "math-test", Elapsed: 0.1 }
    );
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toBe("runtime error: invalid memory address or nil pointer dereference");
    expect(result.failures![0].file).toBe("math_test.go");
    expect(result.failures![0].line).toBe(20);
  });

  it("all passing → status pass", async () => {
    const stdout = ndjson(
      { Action: "run", Package: "math-test", Test: "TestAdd" },
      { Action: "pass", Package: "math-test", Test: "TestAdd" },
      { Action: "pass", Package: "math-test", Elapsed: 0.1 }
    );
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → status error", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("error");
  });
});
