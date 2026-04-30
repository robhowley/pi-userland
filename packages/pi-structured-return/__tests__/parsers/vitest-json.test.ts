import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/vitest-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "vitest run --reporter=json",
    argv: ["vitest", "run", "--reporter=json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

const passing = (name: string) => ({
  fullName: name,
  status: "passed" as const,
  failureMessages: [],
});

const failing = (name: string, message: string) => ({
  fullName: name,
  status: "failed" as const,
  failureMessages: [`${message}\n  at Object.<anonymous> (test.ts:10:5)`],
});

describe("vitest-json parser", () => {
  it("all passing → status pass, summary reflects passed count", async () => {
    const report = {
      numPassedTests: 5,
      numFailedTests: 0,
      testResults: [
        {
          name: "/project/src/foo.test.ts",
          status: "passed",
          assertionResults: [passing("foo test a"), passing("foo test b")],
        },
      ],
    };
    const result = await parser.parse(makeCtx(JSON.stringify(report)));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("5 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("mix of passed and failed → status fail, correct counts, failures listed", async () => {
    const cwd = "/project";
    const report = {
      numPassedTests: 3,
      numFailedTests: 2,
      testResults: [
        {
          name: "/project/src/foo.test.ts",
          status: "failed",
          assertionResults: [passing("foo passes"), failing("foo fails A", "AssertionError: expected 1 to equal 2")],
        },
        {
          name: "/project/src/bar.test.ts",
          status: "failed",
          assertionResults: [failing("bar fails B", "AssertionError: expected true to be false")],
        },
      ],
    };
    const result = await parser.parse(makeCtx(JSON.stringify(report), cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 failed, 3 passed");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/foo.test.ts");
    expect(result.failures![1].file).toBe("src/bar.test.ts");
  });

  it("failure message → first line only surfaced", async () => {
    const report = {
      numPassedTests: 0,
      numFailedTests: 1,
      testResults: [
        {
          name: "/project/src/foo.test.ts",
          status: "failed",
          assertionResults: [failing("foo fails", "AssertionError: expected 1 to equal 2")],
        },
      ],
    };
    const result = await parser.parse(makeCtx(JSON.stringify(report)));
    expect(result.failures![0].message).toBe("AssertionError: expected 1 to equal 2");
  });

  it("relative paths in failure file field", async () => {
    const cwd = "/project";
    const report = {
      numPassedTests: 0,
      numFailedTests: 1,
      testResults: [
        {
          name: "/project/src/deep/foo.test.ts",
          status: "failed",
          assertionResults: [failing("foo fails", "Error")],
        },
      ],
    };
    const result = await parser.parse(makeCtx(JSON.stringify(report), cwd));
    expect(result.failures![0].file).toBe("src/deep/foo.test.ts");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("empty stdout → status error, no crash", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("error");
  });
});
