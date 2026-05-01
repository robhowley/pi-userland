import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/rubocop-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubocop-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "rubocop lint_check.rb --format json",
    argv: ["rubocop", "lint_check.rb", "--format", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("rubocop-json parser", () => {
  it("multiple offenses → correct file, line, message, rule, status fail", async () => {
    const stdout = JSON.stringify({
      metadata: {},
      files: [
        {
          path: "lint_check.rb",
          offenses: [
            {
              severity: "warning",
              message: "Lint/UselessAssignment: Useless assignment to variable - `discount`.",
              cop_name: "Lint/UselessAssignment",
              corrected: false,
              location: { start_line: 2, start_column: 3, line: 2, column: 3 },
            },
            {
              severity: "convention",
              message:
                "Style/StringLiterals: Prefer single-quoted strings when you don't need string interpolation or special symbols.",
              cop_name: "Style/StringLiterals",
              corrected: false,
              location: { start_line: 6, start_column: 20, line: 6, column: 20 },
            },
          ],
        },
      ],
      summary: { offense_count: 2 },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0]).toMatchObject({
      file: "lint_check.rb",
      line: 2,
      message: "Useless assignment to variable - `discount`.",
      rule: "Lint/UselessAssignment",
    });
    expect(result.failures![1].rule).toBe("Style/StringLiterals");
  });

  it("no offenses → status pass", async () => {
    const stdout = JSON.stringify({
      metadata: {},
      files: [{ path: "clean.rb", offenses: [] }],
      summary: { offense_count: 0 },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
  });

  it("absolute file paths → relativized to cwd", async () => {
    const stdout = JSON.stringify({
      metadata: {},
      files: [
        {
          path: "/project/src/foo.rb",
          offenses: [
            { severity: "warning", message: "Lint/Foo: bar", cop_name: "Lint/Foo", location: { line: 1, column: 1 } },
          ],
        },
      ],
      summary: { offense_count: 1 },
    });
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("src/foo.rb");
  });

  it("strips cop_name prefix from message", async () => {
    const stdout = JSON.stringify({
      metadata: {},
      files: [
        {
          path: "foo.rb",
          offenses: [
            {
              severity: "convention",
              message: "Style/FrozenStringLiteralComment: Missing frozen string literal comment.",
              cop_name: "Style/FrozenStringLiteralComment",
              location: { line: 1, column: 1 },
            },
          ],
        },
      ],
      summary: { offense_count: 1 },
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].message).toBe("Missing frozen string literal comment.");
  });
});
