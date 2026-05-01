import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { stripCdPrefix, formatResult, finalizeResult, expandArtifactPaths } from "../extensions/structured-return";

describe("stripCdPrefix", () => {
  it("strips cd /path && prefix", () => {
    expect(stripCdPrefix("cd /some/path && npx eslint . -f json")).toBe("npx eslint . -f json");
  });

  it("leaves commands without cd unchanged", () => {
    expect(stripCdPrefix("npx eslint . -f json")).toBe("npx eslint . -f json");
  });

  it("handles paths with no trailing space variations", () => {
    expect(stripCdPrefix("cd /a/b/c &&npx eslint .")).toBe("npx eslint .");
  });
});

describe("formatResult", () => {
  it("includes cwd when set", () => {
    const result = formatResult({
      tool: "eslint",
      exitCode: 1,
      status: "fail",
      summary: "1 lint errors",
      cwd: "/project",
      failures: [],
    });
    expect(result).toContain("cwd: /project");
  });

  it("omits cwd line when not set", () => {
    const result = formatResult({
      tool: "eslint",
      exitCode: 0,
      status: "pass",
      summary: "no lint errors",
    });
    expect(result).not.toContain("cwd:");
  });

  it("renders relative paths in failure lines", () => {
    const result = formatResult({
      tool: "eslint",
      exitCode: 1,
      status: "fail",
      summary: "1 lint errors",
      cwd: "/project",
      failures: [
        { id: "src/foo.ts:10:rule", file: "src/foo.ts", line: 10, message: "Unexpected any.", rule: "no-explicit-any" },
      ],
    });
    expect(result).toContain("src/foo.ts:10");
    expect(result).not.toContain("/project/src/foo.ts");
  });

  it("includes column and severity in failure lines", () => {
    const result = formatResult({
      tool: "checkstyle",
      exitCode: 4,
      status: "fail",
      summary: "2 findings (2 errors)",
      cwd: "/project",
      failures: [
        { id: "src/Test.java:5:1:LineLength", file: "src/Test.java", line: 5, column: 1, message: "Line is too long.", rule: "LineLength", severity: "error" },
      ],
    });
    expect(result).toContain("src/Test.java:5:1");
    expect(result).toContain("[error]");
    expect(result).toContain("[LineLength]");
  });
});

describe("finalizeResult", () => {
  it("status error with exit code 0 flips to pass", () => {
    const result = finalizeResult(
      {
        tool: "unknown",
        status: "error",
        summary: "no parser matched; returning tail + log path",
        logPath: "/log",
      },
      0,
      "/log",
      "/project"
    );
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("command completed; no parser matched");
  });

  it("status error with non-zero exit code stays error", () => {
    const result = finalizeResult(
      {
        tool: "unknown",
        status: "error",
        summary: "no parser matched; returning tail + log path",
        logPath: "/log",
      },
      1,
      "/log",
      "/project"
    );
    expect(result.status).toBe("error");
  });

  it("attaches cwd to result", () => {
    const result = finalizeResult(
      { tool: "eslint", status: "pass", summary: "no lint errors", logPath: "/log" },
      0,
      "/log",
      "/project"
    );
    expect(result.cwd).toBe("/project");
  });

  it("appends rawTail when parser reports failures but extracts no details", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
    const logPath = path.join(dir, "combined.log");
    fs.writeFileSync(logPath, "line1\nline2\nFAIL: something broke\n");
    const result = finalizeResult(
      { tool: "ava", status: "fail", summary: "2 failed, 1 passed", failures: [] },
      1,
      logPath,
      "/project"
    );
    expect(result.rawTail).toContain("FAIL: something broke");
  });

  it("does not overwrite rawTail when parser already set it", () => {
    const result = finalizeResult(
      { tool: "dbt", status: "fail", summary: "1 error", failures: [], rawTail: "SELECT * FROM ..." },
      1,
      "/nonexistent/log",
      "/project"
    );
    expect(result.rawTail).toBe("SELECT * FROM ...");
  });
});

describe("expandArtifactPaths", () => {
  it("expands glob patterns to matching files (sorted)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-glob-"));
    fs.writeFileSync(path.join(dir, "TEST-Bar.xml"), "<bar/>");
    fs.writeFileSync(path.join(dir, "TEST-Foo.xml"), "<foo/>");
    fs.writeFileSync(path.join(dir, "other.txt"), "ignore");

    const result = expandArtifactPaths(["TEST-*.xml"], dir);
    expect(result).toEqual([path.join(dir, "TEST-Bar.xml"), path.join(dir, "TEST-Foo.xml")]);
  });

  it("keeps unmatched patterns as-is (parser handles missing files)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-nomatch-"));
    const result = expandArtifactPaths(["reports/TEST-*.xml"], dir);
    expect(result).toEqual([path.join(dir, "reports/TEST-*.xml")]);
  });

  it("resolves relative paths against cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-rel-"));
    const sub = path.join(dir, "build");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "report.xml"), "<ok/>");

    const result = expandArtifactPaths(["build/report.xml"], dir);
    expect(result).toEqual([path.join(dir, "build/report.xml")]);
  });

  it("passes through absolute paths unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-abs-"));
    fs.writeFileSync(path.join(dir, "report.xml"), "<ok/>");

    const abs = path.join(dir, "report.xml");
    const result = expandArtifactPaths([abs], "/some/other/cwd");
    expect(result).toEqual([abs]);
  });

  it("handles multiple patterns, some with globs and some without", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-multi-"));
    fs.writeFileSync(path.join(dir, "TEST-A.xml"), "a");
    fs.writeFileSync(path.join(dir, "TEST-B.xml"), "b");
    fs.writeFileSync(path.join(dir, "coverage.xml"), "c");

    const result = expandArtifactPaths(["TEST-*.xml", "coverage.xml"], dir);
    expect(result).toEqual([
      path.join(dir, "TEST-A.xml"),
      path.join(dir, "TEST-B.xml"),
      path.join(dir, "coverage.xml"),
    ]);
  });

  it("expands globs with * in directory positions (multi-module Gradle)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expand-dirglob-"));
    const modA = path.join(dir, "moduleA", "build", "test-results", "test");
    const modB = path.join(dir, "moduleB", "build", "test-results", "test");
    fs.mkdirSync(modA, { recursive: true });
    fs.mkdirSync(modB, { recursive: true });
    fs.writeFileSync(path.join(modA, "TEST-FooTest.xml"), "<foo/>");
    fs.writeFileSync(path.join(modB, "TEST-BarTest.xml"), "<bar/>");

    const result = expandArtifactPaths(["*/build/test-results/test/TEST-*.xml"], dir);
    expect(result).toEqual([path.join(modA, "TEST-FooTest.xml"), path.join(modB, "TEST-BarTest.xml")]);
  });

  it("returns empty array for empty input", () => {
    expect(expandArtifactPaths([], "/any")).toEqual([]);
  });
});

describe("formatResult safety net", () => {
  it("surfaces log path and rawTail when failures detected but no details parsed", () => {
    const result = formatResult({
      tool: "ava",
      exitCode: 1,
      status: "fail",
      summary: "2 failed, 1 passed",
      failures: [],
      logPath: "/tmp/ava-run.log",
      rawTail: "FAIL: test_multiply\nexpected 99, got 12",
    });
    expect(result).toContain("log: /tmp/ava-run.log");
    expect(result).toContain("expected 99, got 12");
  });

  it("does not surface log path when failures have details", () => {
    const result = formatResult({
      tool: "ava",
      exitCode: 1,
      status: "fail",
      summary: "1 failed",
      failures: [{ id: "test1", file: "test.js", line: 5, message: "boom" }],
      logPath: "/tmp/ava-run.log",
    });
    expect(result).not.toContain("log:");
  });
});
