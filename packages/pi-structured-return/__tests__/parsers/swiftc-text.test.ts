import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/swiftc-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swiftc-test-"));
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stderrPath, stderr);
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, "");
  return {
    command: "swiftc -typecheck type_check.swift",
    argv: ["swiftc", "-typecheck", "type_check.swift"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("swiftc-text parser", () => {
  it("multiple errors with source annotations → deduplicated, correct file/line/message", async () => {
    const stderr = [
      "type_check.swift:5:22: error: cannot convert value of type 'Int' to specified type 'String'",
      "3 | }",
      "4 | ",
      "5 | let result: String = add(1, 2)",
      "  |                      `- error: cannot convert value of type 'Int' to specified type 'String'",
      '6 | let total: Int = add("hello", 3)',
      "",
      "type_check.swift:6:22: error: cannot convert value of type 'String' to expected argument type 'Int'",
      "5 | let result: String = add(1, 2)",
      '6 | let total: Int = add("hello", 3)',
      "  |                      `- error: cannot convert value of type 'String' to expected argument type 'Int'",
    ].join("\n");
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 errors");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0]).toMatchObject({
      file: "type_check.swift",
      line: 5,
      message: "cannot convert value of type 'Int' to specified type 'String'",
    });
    expect(result.failures![1]).toMatchObject({ file: "type_check.swift", line: 6 });
  });

  it("empty stderr → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("absolute paths → relativized", async () => {
    const stderr = "/project/Sources/main.swift:10:5: error: use of unresolved identifier 'foo'";
    const result = await parser.parse(makeCtx(stderr, "/project"));
    expect(result.failures![0].file).toBe("Sources/main.swift");
  });

  it("warnings are skipped", async () => {
    const stderr = [
      "foo.swift:1:1: warning: expression of type 'Int' is unused",
      "foo.swift:2:1: error: cannot find 'bar' in scope",
    ].join("\n");
    const result = await parser.parse(makeCtx(stderr));
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toBe("cannot find 'bar' in scope");
  });
});
