import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/cargo-build";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdoutContent: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cargo-build-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  const logPath = path.join(dir, "combined.log");
  fs.writeFileSync(stdoutPath, stdoutContent);
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(logPath, stdoutContent);
  return {
    command: "cargo build --message-format=json",
    argv: ["cargo", "build", "--message-format=json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath,
  };
}

/** Build a minimal compiler-message NDJSON line */
function compilerMessage(opts: {
  level: string;
  message: string;
  code?: string;
  file?: string;
  line?: number;
  label?: string;
}): string {
  const span = opts.file
    ? [
        {
          file_name: opts.file,
          line_start: opts.line ?? 1,
          is_primary: true,
          label: opts.label ?? null,
        },
      ]
    : [];
  return JSON.stringify({
    reason: "compiler-message",
    message: {
      message: opts.message,
      level: opts.level,
      code: opts.code ? { code: opts.code } : null,
      spans: span,
    },
  });
}

const BUILD_FINISHED_OK = JSON.stringify({ reason: "build-finished", success: true });
const BUILD_FINISHED_ERR = JSON.stringify({ reason: "build-finished", success: false });

describe("cargo-build parser", () => {
  it("two errors → status fail, correct count and details", async () => {
    const stdout = [
      compilerMessage({
        level: "error",
        message: "mismatched types",
        code: "E0308",
        file: "src/main.rs",
        line: 6,
        label: "expected `i32`, found `&str`",
      }),
      compilerMessage({
        level: "error",
        message: "cannot find value `missing_var` in this scope",
        code: "E0425",
        file: "src/main.rs",
        line: 7,
        label: "not found in this scope",
      }),
      BUILD_FINISHED_ERR,
    ].join("\n");

    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 errors");
    expect(result.failures).toHaveLength(2);

    const first = result.failures![0];
    expect(first.file).toBe("src/main.rs");
    expect(first.line).toBe(6);
    expect(first.rule).toBe("E0308");
    expect(first.message).toBe("mismatched types\nexpected `i32`, found `&str`");

    const second = result.failures![1];
    expect(second.file).toBe("src/main.rs");
    expect(second.line).toBe(7);
    expect(second.rule).toBe("E0425");
  });

  it("single error, no code → message only, no rule", async () => {
    const stdout = [
      compilerMessage({ level: "error", message: "something went wrong", file: "src/lib.rs", line: 3 }),
      BUILD_FINISHED_ERR,
    ].join("\n");

    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 error");
    expect(result.failures![0].rule).toBeUndefined();
    expect(result.failures![0].message).toBe("something went wrong");
  });

  it("warnings are ignored, only errors count", async () => {
    const stdout = [
      compilerMessage({ level: "warning", message: "unused variable", file: "src/lib.rs", line: 1 }),
      BUILD_FINISHED_OK,
    ].join("\n");

    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("build succeeded");
    expect(result.failures).toHaveLength(0);
  });

  it("no errors → build succeeded", async () => {
    const stdout = [BUILD_FINISHED_OK].join("\n");
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("build succeeded");
  });

  it("non-JSON lines mixed in (e.g. cargo human-readable stderr leaked) are skipped", async () => {
    const stdout = [
      "   Compiling myapp v0.1.0",
      compilerMessage({ level: "error", message: "broken", file: "src/lib.rs", line: 5 }),
      "error: could not compile",
      BUILD_FINISHED_ERR,
    ].join("\n");

    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.failures).toHaveLength(1);
  });

  it("file path made relative to cwd", async () => {
    const cwd = "/project";
    const stdout = [
      compilerMessage({ level: "error", message: "oops", file: "src/lib.rs", line: 1 }),
      BUILD_FINISHED_ERR,
    ].join("\n");

    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.failures![0].file).toBe("src/lib.rs");
    expect(result.failures![0].file).not.toContain("/project");
  });

  it("failure-note level messages are skipped", async () => {
    const stdout = [
      compilerMessage({
        level: "failure-note",
        message: "Some errors have detailed explanations: E0308.",
      }),
      compilerMessage({ level: "error", message: "mismatched types", code: "E0308", file: "src/main.rs", line: 2 }),
      BUILD_FINISHED_ERR,
    ].join("\n");

    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures).toHaveLength(1);
    expect(result.failures![0].rule).toBe("E0308");
  });
});
