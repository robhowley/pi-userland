import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/htmlhint-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "htmlhint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "npx htmlhint --format json .",
    argv: ["npx", "htmlhint", "--format", "json", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("htmlhint-json parser", () => {
  it("multiple errors → correct relative paths, rule IDs, messages", async () => {
    const cwd = "/project";
    const stderr = JSON.stringify([
      {
        file: "/project/src/index.html",
        messages: [
          {
            type: "error",
            message: "Doctype must be declared before any non-comment content.",
            line: 1,
            col: 1,
            rule: { id: "doctype-first", description: "...", link: "https://example.com" },
          },
          {
            type: "error",
            message: "The html element name of [ DIV ] must be in lowercase.",
            line: 5,
            col: 1,
            rule: { id: "tagname-lowercase", description: "...", link: "https://example.com" },
          },
        ],
        time: 1,
      },
    ]);
    const result = await parser.parse(makeCtx(stderr, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 lint errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/index.html");
    expect(result.failures![0].rule).toBe("doctype-first");
    expect(result.failures![1].line).toBe(5);
    // No URLs in output
    expect(result.failures![0].message).not.toContain("https://");
  });

  it("no errors → status pass", async () => {
    const result = await parser.parse(makeCtx(JSON.stringify([])));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty output → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
