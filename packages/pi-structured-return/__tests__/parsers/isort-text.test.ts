import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/isort-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isort-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "isort --check --diff .",
    argv: ["isort", "--check", "--diff", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("isort-text parser", () => {
  it("unsorted imports with diff → strips diff, extracts file, status fail", async () => {
    const cwd = "/project";
    const stderr = `ERROR: /project/src/app.py Imports are incorrectly sorted and/or formatted.
--- /project/src/app.py:before\t2026-03-19 18:00:00
+++ /project/src/app.py:after\t2026-03-19 18:00:00
@@ -1,3 +1,3 @@
+import json
 import os
-import json
ERROR: /project/src/utils.py Imports are incorrectly sorted and/or formatted.`;
    const result = await parser.parse(makeCtx(stderr, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 files have incorrectly sorted imports");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/app.py");
    expect(result.failures![1].file).toBe("src/utils.py");
    // No diff content in failures
    expect(result.failures![0].message).not.toContain("---");
  });

  it("all sorted → status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("all imports sorted");
    expect(result.failures).toHaveLength(0);
  });

  it("single file → singular grammar", async () => {
    const stderr = `ERROR: /project/bad.py Imports are incorrectly sorted and/or formatted.`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.summary).toBe("1 file has incorrectly sorted imports");
  });
});
