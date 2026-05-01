import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/node-test-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-test-text-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, "");
  return {
    command: "node --test",
    argv: ["node", "--test"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("node-test-text parser", () => {
  it("mixed pass/fail → correct summary, file:line, and assertion messages", async () => {
    const cwd = "/project";
    const stdout = `▶ math
  ✔ adds two numbers correctly (0.329ms)
  ✖ multiplies two numbers correctly (0.466ms)
  ✖ does not divide by zero (5.098ms)
✖ math (6.373ms)
ℹ tests 3
ℹ suites 1
ℹ pass 1
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 68.049

✖ failing tests:

test at /project/src/test_math.mjs:9:3
✖ multiplies two numbers correctly (0.466ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  12 !== 99
  
      at TestContext.<anonymous> (file:///project/src/test_math.mjs:10:12)
      at Test.runInAsyncScope (node:async_hooks:226:14)

test at /project/src/test_math.mjs:13:3
✖ does not divide by zero (5.098ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  
    assert.ok(isFinite(result))
  
      at TestContext.<anonymous> (file:///project/src/test_math.mjs:15:12)`;
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 failed, 1 passed");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/test_math.mjs");
    expect(result.failures![0].line).toBe(9);
    expect(result.failures![0].message).toContain("12 !== 99");
    expect(result.failures![1].message).toContain("assert.ok(isFinite(result))");
    // No stack traces in output
    expect(result.failures![0].message).not.toContain("at Test");
  });

  it("all passing → status pass, no failures", async () => {
    const stdout = `▶ math
  ✔ adds correctly (0.2ms)
✔ math (1ms)
ℹ tests 1
ℹ suites 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 50.0`;
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("non-assertion error (TypeError) → captures error message", async () => {
    const cwd = "/project";
    const stdout = `▶ suite
  ✖ throws type error (1ms)
✖ suite (2ms)
ℹ tests 1
ℹ suites 1
ℹ pass 0
ℹ fail 1
ℹ duration_ms 50.0

✖ failing tests:

test at /project/src/test.mjs:5:3
✖ throws type error (1ms)
  TypeError: Cannot read properties of null (reading 'foo')
      at TestContext.<anonymous> (file:///project/src/test.mjs:6:10)
      at Test.runInAsyncScope (node:async_hooks:226:14)`;
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toContain("Cannot read properties of null");
    expect(result.failures![0].message).not.toContain("at Test");
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
