import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "./prettier-text";
import type { RunContext } from "../types";

function makeCtx(stdout: string, stderr = "", cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prettier-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "prettier --check .",
    argv: ["prettier", "--check", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("prettier-text parser", () => {
  it("files needing formatting → strips preamble/footer, lists files", async () => {
    const cwd = "/project";
    const stdout = `Checking formatting...
[warn] /project/src/app.ts
[warn] /project/src/utils.ts
[warn] Code style issues found in 2 files. Run Prettier with --write to fix.`;
    const result = await parser.parse(makeCtx(stdout, "", cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 files have formatting issues");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("src/app.ts");
    expect(result.failures![1].file).toBe("src/utils.ts");
  });

  it("all formatted → status pass", async () => {
    const stdout = `Checking formatting...
All matched files use Prettier code style!`;
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("all files formatted");
    expect(result.failures).toHaveLength(0);
  });

  it("single file → singular grammar", async () => {
    const stdout = `Checking formatting...
[warn] /project/bad.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.`;
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 file has formatting issues");
  });

  it("extensionless files (Dockerfile, Makefile) → not dropped", async () => {
    const cwd = "/project";
    const stdout = `Checking formatting...
[warn] /project/Dockerfile
[warn] /project/src/app.ts
[warn] Code style issues found in 2 files. Run Prettier with --write to fix.`;
    const result = await parser.parse(makeCtx(stdout, "", cwd));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("Dockerfile");
    expect(result.failures![1].file).toBe("src/app.ts");
  });

  it("empty output → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
