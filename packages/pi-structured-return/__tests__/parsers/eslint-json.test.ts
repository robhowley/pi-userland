import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/eslint-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eslint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "eslint . -f json",
    argv: ["eslint", ".", "-f", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("eslint-json parser", () => {
  it("multiple errors across multiple files → correct relative paths, correct failure count, status fail", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify([
      {
        filePath: "/project/src/foo.ts",
        messages: [
          { line: 10, ruleId: "@typescript-eslint/no-explicit-any", message: "Unexpected any." },
          { line: 12, ruleId: "@typescript-eslint/no-explicit-any", message: "Unexpected any." },
        ],
      },
      {
        filePath: "/project/src/bar.ts",
        messages: [{ line: 3, ruleId: "no-unused-vars", message: "x is defined but never used." }],
      },
    ]);
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(3);
    expect(result.failures![0].file).toBe("src/foo.ts");
    expect(result.failures![1].file).toBe("src/foo.ts");
    expect(result.failures![2].file).toBe("src/bar.ts");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("no errors → empty failures, status pass", async () => {
    const stdout = JSON.stringify([{ filePath: "/project/src/foo.ts", messages: [] }]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
