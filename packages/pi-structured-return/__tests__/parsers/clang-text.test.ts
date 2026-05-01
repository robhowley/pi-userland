import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/clang-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clang-test-"));
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "gcc -c src/main.c",
    argv: ["gcc", "-c", "src/main.c"],
    cwd,
    artifactPaths: [],
    stdoutPath: path.join(dir, "stdout"),
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("clang-text parser", () => {
  it("two errors with source snippets → strips snippets, extracts file:line and message", async () => {
    const cwd = "/project";
    const stderr = `/project/src/main.c:4:9: error: incompatible pointer to integer conversion initializing 'int' with an expression of type 'char[6]' [-Wint-conversion]
    4 |     int x = "hello";
      |         ^   ~~~~~~~
/project/src/main.c:5:20: error: use of undeclared identifier 'undeclared_var'
    5 |     printf("%d\\n", undeclared_var);
      |                    ^
2 errors generated.`;
    const result = await parser.parse(makeCtx(stderr, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 errors generated.");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/main.c");
    expect(result.failures![0].line).toBe(4);
    expect(result.failures![0].rule).toBe("-Wint-conversion");
    expect(result.failures![1].file).toBe("src/main.c");
    expect(result.failures![1].line).toBe(5);
    expect(result.failures![1].rule).toBeUndefined();
  });

  it("fatal error → captured as failure", async () => {
    const stderr = `/project/src/main.c:1:10: fatal error: 'nonexistent.h' file not found
    1 | #include <nonexistent.h>
      |          ^~~~~~~~~~~~~~~
1 error generated.`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].message).toContain("nonexistent.h");
  });

  it("empty stderr → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
