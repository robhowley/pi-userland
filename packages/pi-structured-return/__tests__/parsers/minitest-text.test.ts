import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/minitest-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minitest-text-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "ruby test/math_test.rb",
    argv: ["ruby", "test/math_test.rb"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

const PASSING_OUTPUT = `Run options: --seed 12345

# Running:

...

Finished in 0.001s, 3000.0 runs/s, 3000.0 assertions/s.

3 runs, 3 assertions, 0 failures, 0 errors, 0 skips
`;

const MIXED_OUTPUT = `Run options: --seed 12345

# Running:

EF.

Finished in 0.001s, 3000.0 runs/s, 2000.0 assertions/s.

  1) Error:
MathTest#test_does_not_divide_by_zero:
ZeroDivisionError: divided by 0
    /project/test/math_test.rb:13:in 'Integer#/'
    /project/test/math_test.rb:13:in 'MathTest#test_does_not_divide_by_zero'

  2) Failure:
MathTest#test_multiplies_two_numbers_correctly [/project/test/math_test.rb:9]:
Expected: 99
  Actual: 12

3 runs, 2 assertions, 1 failures, 1 errors, 0 skips
`;

describe("minitest-text parser", () => {
  it("all passing → status pass, summary reflects passed count", async () => {
    const result = await parser.parse(makeCtx(PASSING_OUTPUT));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("3 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("mix of failure and error → status fail, correct counts", async () => {
    const result = await parser.parse(makeCtx(MIXED_OUTPUT, "/project"));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 failed, 1 passed");
    expect(result.failures).toHaveLength(2);
  });

  it("assertion failure → file, line, and expected/actual message", async () => {
    const result = await parser.parse(makeCtx(MIXED_OUTPUT, "/project"));
    const failure = result.failures!.find((f) => f.id?.includes("multiplies"));
    expect(failure?.file).toBe("test/math_test.rb");
    expect(failure?.line).toBe(9);
    expect(failure?.message).toBe("Expected: 99 / Actual: 12");
  });

  it("unexpected error → file, line from backtrace, exception message only", async () => {
    const result = await parser.parse(makeCtx(MIXED_OUTPUT, "/project"));
    const error = result.failures!.find((f) => f.id?.includes("divide_by_zero"));
    expect(error?.file).toBe("test/math_test.rb");
    expect(error?.line).toBe(13);
    expect(error?.message).toBe("divided by 0");
  });

  it("absolute paths in output → made relative to cwd", async () => {
    const result = await parser.parse(makeCtx(MIXED_OUTPUT, "/project"));
    for (const f of result.failures!) {
      expect(f.file).not.toContain("/project");
    }
  });

  it("relative paths in output → kept relative", async () => {
    const output = MIXED_OUTPUT.replace(/\/project\/test\//g, "./test/").replace(/\/project\/test\//g, "./test/");
    const result = await parser.parse(makeCtx(output, "/project"));
    const failure = result.failures!.find((f) => f.id?.includes("multiplies"));
    expect(failure?.file).toBe("test/math_test.rb");
  });

  it("no minitest output → status error, no crash", async () => {
    const result = await parser.parse(makeCtx("something completely different"));
    expect(result.status).toBe("error");
  });

  it("empty stdout → status error, no crash", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("error");
  });
});
