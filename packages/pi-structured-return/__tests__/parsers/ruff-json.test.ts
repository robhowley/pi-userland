import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/ruff-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruff-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "ruff check . --output-format=json",
    argv: ["ruff", "check", ".", "--output-format=json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("ruff-json parser", () => {
  it("multiple errors across multiple files → correct relative paths, rule code mapped to rule, status fail", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify([
      { filename: "/project/src/foo.py", code: "F401", message: "`os` imported but unused", location: { row: 1 } },
      { filename: "/project/src/foo.py", code: "E741", message: "Ambiguous variable name: `l`", location: { row: 5 } },
      {
        filename: "/project/src/bar.py",
        code: "F841",
        message: "Local variable `x` is assigned to but never used",
        location: { row: 3 },
      },
    ]);
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(3);
    expect(result.failures![0].file).toBe("src/foo.py");
    expect(result.failures![2].file).toBe("src/bar.py");
    expect(result.failures![0].file).not.toContain("/project");
    expect(result.failures![0].rule).toBe("F401");
    expect(result.failures![1].rule).toBe("E741");
  });

  it("no errors → empty failures, status pass", async () => {
    const result = await parser.parse(makeCtx(JSON.stringify([])));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
