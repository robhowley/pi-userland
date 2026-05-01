import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/ava-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ava-test-"));
  const stderrPath = path.join(dir, "stderr");
  const stdoutPath = path.join(dir, "stdout");
  const logPath = path.join(dir, "log");
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(stdoutPath, stderr);
  fs.writeFileSync(logPath, stderr);
  return {
    command: "npx ava test_math.js --no-color",
    argv: ["npx", "ava", "test_math.js", "--no-color"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath,
  };
}

const FAILURE_OUTPUT = `
  ✔ adds two numbers correctly
  ✘ [fail]: multiplies two numbers correctly
  ✘ [fail]: does not divide by zero Error thrown in test
  ─

  multiplies two numbers correctly

  test_math.js:8

   7: test('multiplies two numbers correctly', t => {
   8:     t.is(3 * 4, 99);                           
   9: });                                            

  Difference (- actual, + expected):

  - 12
  + 99



  does not divide by zero

  Error thrown in test:

  TypeError {
    message: 'Cannot read properties of null (reading \\'value\\')',
  }

  TypeError: Cannot read properties of null (reading 'value')
      at /project/benchmarks/test-runners/ava/test_math.js:12:29
      at Test.callFn (file:///project/node_modules/ava/lib/test.js:525:26)
      at Test.run (file:///project/node_modules/ava/lib/test.js:534:33)

  ─

  2 tests failed
  1 test passed
`;

const SUCCESS_OUTPUT = `
  ✔ adds two numbers correctly
  ─

  1 test passed
`;

describe("ava-text parser", () => {
  it("parses assertion failure with expected/actual and file:line", async () => {
    const result = await parser.parse(makeCtx(FAILURE_OUTPUT));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 failed, 1 passed");
    expect(result.failures).toHaveLength(2);

    const assertion = result.failures![0];
    expect(assertion.id).toBe("multiplies two numbers correctly");
    expect(assertion.file).toBe("test_math.js");
    expect(assertion.line).toBe(8);
    expect(assertion.message).toBe("expected 99, got 12");
  });

  it("parses runtime error with message and file:line from stack", async () => {
    const result = await parser.parse(makeCtx(FAILURE_OUTPUT));
    const runtime = result.failures![1];
    expect(runtime.id).toBe("does not divide by zero");
    expect(runtime.file).toBe("benchmarks/test-runners/ava/test_math.js");
    expect(runtime.line).toBe(12);
    expect(runtime.message).toBe("Cannot read properties of null (reading \\'value\\')");
  });

  it("all passing → status pass", async () => {
    const result = await parser.parse(makeCtx(SUCCESS_OUTPUT));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stderr → status error", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("error");
  });

  it("file paths are relative to cwd", async () => {
    const result = await parser.parse(makeCtx(FAILURE_OUTPUT));
    const runtime = result.failures![1];
    // absolute /project/benchmarks/... becomes relative to /project
    expect(runtime.file).not.toMatch(/^\//);
    expect(runtime.file).toBe("benchmarks/test-runners/ava/test_math.js");
  });
});
