import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/hadolint-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hadolint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "hadolint Dockerfile --format json",
    argv: ["hadolint", "Dockerfile", "--format", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("hadolint-json parser", () => {
  it("multiple errors → correct file, line, message, rule", async () => {
    const stdout = JSON.stringify([
      {
        code: "DL3007",
        column: 1,
        file: "Dockerfile",
        level: "warning",
        line: 1,
        message: "Using latest is prone to errors.",
      },
      {
        code: "DL3008",
        column: 1,
        file: "Dockerfile",
        level: "warning",
        line: 2,
        message: "Pin versions in apt get install.",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures![0]).toMatchObject({
      file: "Dockerfile",
      line: 1,
      message: "Using latest is prone to errors.",
      rule: "DL3007",
    });
    expect(result.failures![1]).toMatchObject({ rule: "DL3008" });
  });

  it("empty array → status pass", async () => {
    const result = await parser.parse(makeCtx("[]"));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
  });

  it("absolute paths → relativized", async () => {
    const stdout = JSON.stringify([
      { code: "DL3003", column: 1, file: "/project/Dockerfile", level: "warning", line: 3, message: "Use WORKDIR" },
    ]);
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("Dockerfile");
  });
});
