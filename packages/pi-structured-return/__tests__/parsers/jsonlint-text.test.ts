import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/jsonlint-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonlint-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "npx jsonlint src/config.json",
    argv: ["npx", "jsonlint", "src/config.json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("jsonlint-text parser", () => {
  it("parse error with stack trace → strips stack, extracts line and expecting message", async () => {
    const stderr = `Error: Parse error on line 1:
{"name": "test", missing: "quotes", }
-----------------^
Expecting 'STRING', got 'undefined'
    at Object.parseError (jsonlint/lib/jsonlint.js:55:11)
    at Object.parse (jsonlint/lib/jsonlint.js:132:22)
    at parse (jsonlint/lib/cli.js:82:14)
    at main (jsonlint/lib/cli.js:135:14)`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("parse error");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].file).toBe("src/config.json");
    expect(result.failures![0].line).toBe(1);
    expect(result.failures![0].message).toBe("Expecting 'STRING', got 'undefined'");
    // No stack trace
    expect(result.failures![0].message).not.toContain("at Object");
  });

  it("valid JSON → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("valid JSON");
    expect(result.failures).toHaveLength(0);
  });
});
