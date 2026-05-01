import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/mocha-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mocha-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "mocha test_math.js --reporter json",
    argv: ["mocha", "test_math.js", "--reporter", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("mocha-json parser", () => {
  it("assertion failure → expected/actual in message, file:line from stack", async () => {
    const stdout = JSON.stringify({
      stats: { passes: 1, failures: 1 },
      failures: [
        {
          title: "multiplies two numbers correctly",
          fullTitle: "basic math multiplies two numbers correctly",
          file: "/project/test_math.js",
          err: {
            stack:
              "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n12 !== 99\n\n    at Context.<anonymous> (test_math.js:9:12)\n    at process.processImmediate (node:internal/timers:504:21)",
            message: "Expected values to be strictly equal:\n\n12 !== 99\n",
            actual: "12",
            expected: "99",
            operator: "strictEqual",
            code: "ERR_ASSERTION",
            name: "AssertionError",
          },
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 failed, 1 passed");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toBe("expected 99, got 12");
    expect(result.failures![0].file).toBe("test_math.js");
    expect(result.failures![0].line).toBe(9);
    expect(result.failures![0].rule).toBe("ERR_ASSERTION");
  });

  it("runtime error → message from err.message, file:line from stack", async () => {
    const stdout = JSON.stringify({
      stats: { passes: 1, failures: 1 },
      failures: [
        {
          title: "does not divide by zero",
          fullTitle: "basic math does not divide by zero",
          file: "/project/test_math.js",
          err: {
            stack:
              "TypeError: Cannot read properties of null (reading 'value')\n    at Context.<anonymous> (test_math.js:13:29)\n    at process.processImmediate (node:internal/timers:504:21)",
            message: "Cannot read properties of null (reading 'value')",
          },
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].message).toBe("Cannot read properties of null (reading 'value')");
    expect(result.failures![0].file).toBe("test_math.js");
    expect(result.failures![0].line).toBe(13);
  });

  it("all passing → status pass", async () => {
    const stdout = JSON.stringify({ stats: { passes: 3, failures: 0 }, failures: [] });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("3 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → status error", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("error");
  });

  it("file paths relativized to cwd", async () => {
    const stdout = JSON.stringify({
      stats: { passes: 0, failures: 1 },
      failures: [
        {
          title: "fails",
          fullTitle: "suite fails",
          file: "/project/test/foo.js",
          err: {
            stack: "Error: oops\n    at Context.<anonymous> (/project/test/foo.js:5:10)",
            message: "oops",
          },
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("test/foo.js");
  });
});
