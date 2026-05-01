import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/stylelint-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stylelint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "stylelint lint_check.css --formatter json",
    argv: ["stylelint", "lint_check.css", "--formatter", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("stylelint-json parser", () => {
  it("multiple warnings → correct file, line, message, rule", async () => {
    const stdout = JSON.stringify([
      {
        source: "/project/lint_check.css",
        warnings: [
          {
            line: 2,
            column: 3,
            rule: "declaration-block-no-duplicate-properties",
            severity: "error",
            text: 'Unexpected duplicate "color" (declaration-block-no-duplicate-properties)',
          },
          {
            line: 4,
            column: 19,
            rule: "declaration-no-important",
            severity: "error",
            text: "Unexpected !important (declaration-no-important)",
          },
        ],
        deprecations: [],
        invalidOptionWarnings: [],
      },
    ]);
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures![0]).toMatchObject({
      file: "lint_check.css",
      line: 2,
      message: 'Unexpected duplicate "color"',
      rule: "declaration-block-no-duplicate-properties",
    });
    expect(result.failures![1]).toMatchObject({ message: "Unexpected !important", rule: "declaration-no-important" });
  });

  it("no warnings → status pass", async () => {
    const stdout = JSON.stringify([{ source: "clean.css", warnings: [], deprecations: [], invalidOptionWarnings: [] }]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
  });

  it("strips rule name suffix from message text", async () => {
    const stdout = JSON.stringify([
      {
        source: "foo.css",
        warnings: [
          {
            line: 1,
            column: 1,
            rule: "color-no-invalid-hex",
            severity: "error",
            text: 'Unexpected invalid hex color "#FG" (color-no-invalid-hex)',
          },
        ],
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].message).toBe('Unexpected invalid hex color "#FG"');
    expect(result.failures![0].rule).toBe("color-no-invalid-hex");
  });

  it("does not strip trailing parens when they are part of the message, not the rule", async () => {
    const stdout = JSON.stringify([
      {
        source: "foo.css",
        warnings: [
          {
            line: 3,
            column: 10,
            rule: "function-no-unknown",
            severity: "error",
            text: 'Unexpected unknown function "clamp(10px, 5vw, 50px)" (function-no-unknown)',
          },
          {
            line: 7,
            column: 15,
            rule: "value-no-vendor-prefix",
            severity: "error",
            text: "Unexpected value with parentheses calc(100% - 10px)",
          },
        ],
      },
    ]);
    const result = await parser.parse(makeCtx(stdout));
    // First warning: has the standard "(rule-name)" suffix — should be stripped
    expect(result.failures![0].message).toBe('Unexpected unknown function "clamp(10px, 5vw, 50px)"');
    // Second warning: trailing parens are CSS value, not rule suffix — must NOT be stripped
    expect(result.failures![1].message).toBe("Unexpected value with parentheses calc(100% - 10px)");
  });
});
