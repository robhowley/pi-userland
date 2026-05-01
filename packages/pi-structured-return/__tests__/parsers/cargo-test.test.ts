import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/cargo-test";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(logContent: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cargo-test-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  const logPath = path.join(dir, "combined.log");
  fs.writeFileSync(stdoutPath, logContent);
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(logPath, logContent);
  return {
    command: "cargo test",
    argv: ["cargo", "test"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath,
  };
}

// Realistic cargo test output with Rust 1.73+ panic format
const REAL_OUTPUT_NEW_FORMAT = `   Compiling math v0.1.0 (/project)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 1.23s
     Running unittests src/lib.rs (target/debug/deps/math-abc123)

running 3 tests
test tests::adds_two_numbers_correctly ... ok
test tests::multiplies_two_numbers_correctly ... FAILED
test tests::does_not_panic ... FAILED

failures:

---- tests::multiplies_two_numbers_correctly stdout ----

thread 'tests::multiplies_two_numbers_correctly' (12345) panicked at src/lib.rs:20:9:
assertion \`left == right\` failed
  left: 12
 right: 99

---- tests::does_not_panic stdout ----

thread 'tests::does_not_panic' (12346) panicked at src/lib.rs:26:18:
index out of bounds: the len is 0 but the index is 0
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::does_not_panic
    tests::multiplies_two_numbers_correctly

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`--lib\`
`;

// Pre-1.73 panic format
const OLD_FORMAT_PANIC = `running 2 tests
test tests::foo ... FAILED
test tests::bar ... ok

failures:

---- tests::foo stdout ----
thread 'tests::foo' panicked at 'assertion failed: \`(left == right)\`
  left: \`5\`,
 right: \`10\`', src/lib.rs:8:5

failures:
    tests::foo

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const ALL_PASSING = `running 2 tests
test tests::a ... ok
test tests::b ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const COMPILE_ERROR = `   Compiling math v0.1.0 (/project)
error[E0308]: mismatched types
 --> src/lib.rs:5:20
  |
5 |     let x: i32 = "oops";
  |                  ^^^^^^ expected \`i32\`, found \`&str\`

error: could not compile \`math\` due to 1 previous error
`;

describe("cargo-test parser", () => {
  describe("Rust 1.73+ panic format", () => {
    it("2 failed, 1 passed → correct summary and failure details", async () => {
      const result = await parser.parse(makeCtx(REAL_OUTPUT_NEW_FORMAT));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 1 passed");
      expect(result.failures).toHaveLength(2);
    });

    it("assertion failure has file, line, and compact left/right message", async () => {
      const result = await parser.parse(makeCtx(REAL_OUTPUT_NEW_FORMAT));
      const f = result.failures!.find((f) => f.id.includes("20"));
      expect(f).toBeDefined();
      expect(f!.file).toBe("src/lib.rs");
      expect(f!.line).toBe(20);
      expect(f!.message).toMatch(/assertion .* failed/);
      expect(f!.message).toMatch(/left: 12/);
      expect(f!.message).toMatch(/right: 99/);
    });

    it("runtime panic has file, line, and error message", async () => {
      const result = await parser.parse(makeCtx(REAL_OUTPUT_NEW_FORMAT));
      const f = result.failures!.find((f) => f.id.includes("26"));
      expect(f).toBeDefined();
      expect(f!.file).toBe("src/lib.rs");
      expect(f!.line).toBe(26);
      expect(f!.message).toMatch(/index out of bounds/);
    });

    it("file paths are relative", async () => {
      const result = await parser.parse(makeCtx(REAL_OUTPUT_NEW_FORMAT, "/project"));
      for (const f of result.failures!) {
        expect(f.file).not.toMatch(/^\/project/);
      }
    });
  });

  describe("pre-1.73 panic format", () => {
    it("parses old-style panicked at 'message', file:line format", async () => {
      const result = await parser.parse(makeCtx(OLD_FORMAT_PANIC));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 1 passed");
      expect(result.failures).toHaveLength(1);
      const f = result.failures![0];
      expect(f.file).toBe("src/lib.rs");
      expect(f.line).toBe(8);
      expect(f.message).toMatch(/assertion failed/);
    });
  });

  describe("all passing", () => {
    it("all tests pass → status pass, empty failures", async () => {
      const result = await parser.parse(makeCtx(ALL_PASSING));
      expect(result.status).toBe("pass");
      expect(result.summary).toBe("2 passed");
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("compilation failure", () => {
    it("no test result line → status error with guidance message", async () => {
      const result = await parser.parse(makeCtx(COMPILE_ERROR));
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/compilation failed/);
      expect(result.summary).toMatch(/cargo build --message-format=json/);
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("single failing test", () => {
    it("single test failure parsed correctly", async () => {
      const log = `running 1 test
test tests::only_one ... FAILED

failures:

---- tests::only_one stdout ----

thread 'tests::only_one' panicked at src/lib.rs:5:3:
explicit panic

failures:
    tests::only_one

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
      const result = await parser.parse(makeCtx(log));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 0 passed");
      expect(result.failures).toHaveLength(1);
      expect(result.failures![0].line).toBe(5);
      expect(result.failures![0].message).toBe("explicit panic");
    });
  });
});
