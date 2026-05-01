import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/unittest-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unittest-test-"));
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stderrPath, stderr);
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, "");
  return {
    command: "python3 -m unittest test_math.py",
    argv: ["python3", "-m", "unittest", "test_math.py"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

const REAL_FAILURE_OUTPUT = `.EF
======================================================================
ERROR: test_does_not_divide_by_zero (test_math.TestMath.test_does_not_divide_by_zero)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/project/test_math.py", line 12, in test_does_not_divide_by_zero
    result = 1 / 0
             ~~^~~
ZeroDivisionError: division by zero

======================================================================
FAIL: test_multiplies_two_numbers_correctly (test_math.TestMath.test_multiplies_two_numbers_correctly)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/project/test_math.py", line 9, in test_multiplies_two_numbers_correctly
    self.assertEqual(3 * 4, 99)
    ~~~~~~~~~~~~~~~~^^^^^^^^^^^
AssertionError: 12 != 99

----------------------------------------------------------------------
Ran 3 tests in 0.001s

FAILED (failures=1, errors=1)`;

describe("unittest-text parser", () => {
  it("real output → assertion failure with expected/actual, runtime error with message", async () => {
    const result = await parser.parse(makeCtx(REAL_FAILURE_OUTPUT));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 failed, 1 passed");
    expect(result.failures).toHaveLength(2);

    // ERROR block
    const err = result.failures!.find((f) => f.rule === "error")!;
    expect(err.file).toBe("test_math.py");
    expect(err.line).toBe(12);
    expect(err.message).toBe("ZeroDivisionError: division by zero");

    // FAIL block
    const fail = result.failures!.find((f) => f.rule === "assertion")!;
    expect(fail.file).toBe("test_math.py");
    expect(fail.line).toBe(9);
    expect(fail.message).toBe("12 != 99");
  });

  it("all passing → status pass", async () => {
    const stderr = `...
----------------------------------------------------------------------
Ran 3 tests in 0.001s

OK`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("3 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stderr → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
  });

  it("file paths relativized to cwd", async () => {
    const result = await parser.parse(makeCtx(REAL_FAILURE_OUTPUT, "/project"));
    for (const f of result.failures!) {
      expect(f.file).not.toContain("/project/");
      expect(f.file).toBe("test_math.py");
    }
  });

  it("skipped tests are not counted as passed", async () => {
    const stderr = `.sF
======================================================================
FAIL: test_fail (test_math.TestMath.test_fail)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/project/test_math.py", line 8, in test_fail
    self.assertEqual(1, 2)
    ~~~~~~~~~~~~~~~~^^^^^^
AssertionError: 1 != 2

----------------------------------------------------------------------
Ran 3 tests in 0.001s

FAILED (failures=1, skipped=1)`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    // 3 total - 1 failed - 1 skipped = 1 passed (not 2)
    expect(result.summary).toBe("1 failed, 1 passed");
    expect(result.failures).toHaveLength(1);
  });

  it("all passing with skips → correct passed count", async () => {
    const stderr = `.s
----------------------------------------------------------------------
Ran 2 tests in 0.001s

OK (skipped=1)`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 passed");
  });
});
