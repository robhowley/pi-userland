import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/markdownlint-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markdownlint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "markdownlint --json .",
    argv: ["markdownlint", "--json", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("markdownlint-json parser", () => {
  it("multiple issues → correct relative paths, rule codes, descriptions", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify([
      {
        fileName: "/project/docs/README.md",
        lineNumber: 1,
        ruleNames: ["MD041", "first-line-heading"],
        ruleDescription: "First line in a file should be a top-level heading",
        errorDetail: null,
      },
      {
        fileName: "/project/docs/README.md",
        lineNumber: 3,
        ruleNames: ["MD009", "no-trailing-spaces"],
        ruleDescription: "Trailing spaces",
        errorDetail: "Expected: 0 or 2; Actual: 3",
      },
    ]);
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("docs/README.md");
    expect(result.failures![0].rule).toBe("MD041");
    expect(result.failures![1].message).toContain("Expected: 0 or 2; Actual: 3");
  });

  it("no issues → status pass", async () => {
    const result = await parser.parse(makeCtx(JSON.stringify([])));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("single issue → singular 'error' in summary", async () => {
    const stdout = JSON.stringify([
      {
        fileName: "/project/README.md",
        lineNumber: 5,
        ruleNames: ["MD032", "blanks-around-lists"],
        ruleDescription: "Lists should be surrounded by blank lines",
        errorDetail: null,
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.summary).toBe("1 lint error");
  });
});
