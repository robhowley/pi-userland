import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/rspec-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rspec-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "bundle exec rspec --format json",
    argv: ["bundle", "exec", "rspec", "--format", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

const passing = (id: string, file: string, line: number): object => ({
  id,
  full_description: id,
  status: "passed",
  file_path: file,
  line_number: line,
});

const failing = (id: string, file: string, line: number, message: string): object => ({
  id,
  full_description: id,
  status: "failed",
  file_path: file,
  line_number: line,
  exception: {
    class: "RSpec::Expectations::ExpectationNotMetError",
    message,
    backtrace: [`${file}:${line}:in 'block (2 levels) in <top (required)>'`],
  },
});

function report(examples: object[], failureCount: number, pendingCount = 0): string {
  return JSON.stringify({
    examples,
    summary: {
      example_count: examples.length,
      failure_count: failureCount,
      pending_count: pendingCount,
    },
  });
}

describe("rspec-json parser", () => {
  it("mix of passed and failed → status fail, correct counts, failures listed", async () => {
    const cwd = "/project";
    const stdout = report(
      [
        passing("Foo does something", "./spec/foo_spec.rb", 5),
        failing("Foo blows up", "./spec/foo_spec.rb", 10, "expected: 2\n     got: 1"),
        passing("Bar works", "./spec/bar_spec.rb", 3),
        failing("Bar also blows up", "./spec/bar_spec.rb", 8, "expected true\n     got false"),
      ],
      2
    );
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 failed, 2 passed");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("spec/foo_spec.rb");
    expect(result.failures![1].file).toBe("spec/bar_spec.rb");
  });

  it("all passing → status pass, summary reflects passed count", async () => {
    const stdout = report(
      [passing("Foo works", "./spec/foo_spec.rb", 5), passing("Bar works", "./spec/bar_spec.rb", 3)],
      0
    );
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("2 passed");
    expect(result.failures).toHaveLength(0);
  });

  it("failure message → expected/got pair joined, stops at blank line", async () => {
    const stdout = report(
      [failing("Foo blows up", "./spec/foo_spec.rb", 10, "\nexpected: 2\n     got: 1\n\n(compared using ==)\n")],
      1
    );
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].message).toBe("expected: 2 / got: 1");
  });

  it("file_path with ./ prefix → stripped in relative path output", async () => {
    const stdout = report([failing("Foo blows up", "./spec/foo_spec.rb", 10, "error")], 1);
    const result = await parser.parse(makeCtx(stdout, "/project"));
    expect(result.failures![0].file).toBe("spec/foo_spec.rb");
    expect(result.failures![0].file).not.toMatch(/^\.\//);
  });

  it("line number preserved on failure", async () => {
    const stdout = report([failing("Foo blows up", "./spec/foo_spec.rb", 42, "error")], 1);
    const result = await parser.parse(makeCtx(stdout));
    expect(result.failures![0].line).toBe(42);
  });

  it("pending tests excluded from passed count", async () => {
    const stdout = report(
      [
        passing("Foo works", "./spec/foo_spec.rb", 5),
        { ...passing("Pending thing", "./spec/foo_spec.rb", 20), status: "pending" },
      ],
      0,
      1
    );
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 passed");
  });

  it("empty stdout → status error, no crash", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("error");
  });
});
