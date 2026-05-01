import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/black-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, stderr = "", cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "black-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "black --check .",
    argv: ["black", "--check", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("black-text parser", () => {
  it("files needing reformat → strips emoji, lists files, status fail", async () => {
    const cwd = "/project";
    const stderr = `would reformat /project/src/app.py
would reformat /project/src/utils.py

Oh no! 💥 💔 💥
2 files would be reformatted.`;
    const result = await parser.parse(makeCtx("", stderr, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 files would be reformatted");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/app.py");
    expect(result.failures![1].file).toBe("src/utils.py");
    expect(result.failures![0].message).toBe("would reformat");
  });

  it("all formatted → status pass", async () => {
    const stderr = `All done! ✨ 🍰 ✨
3 files would be left unchanged.`;
    const result = await parser.parse(makeCtx("", stderr));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("all files formatted");
    expect(result.failures).toHaveLength(0);
  });

  it("format errors → captured with message", async () => {
    const stderr = `error: cannot format /project/bad.py: Cannot parse: 1:0: 
Oh no! 💥 💔 💥
1 file would fail to reformat.`;
    const result = await parser.parse(makeCtx("", stderr));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].file).toBe("bad.py");
    expect(result.failures![0].message).toContain("Cannot parse");
  });

  it("empty output → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
