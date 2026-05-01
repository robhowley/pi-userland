import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/tail-fallback";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(logContent: string): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-test-"));
  const logPath = path.join(dir, "log");
  fs.writeFileSync(logPath, logContent);
  return {
    command: "some-command",
    argv: ["some-command"],
    cwd: "/project",
    artifactPaths: [],
    stdoutPath: path.join(dir, "stdout"),
    stderrPath: path.join(dir, "stderr"),
    logPath,
  };
}

describe("tail-fallback parser", () => {
  it("any command → status error, summary contains log path", async () => {
    const ctx = makeCtx("some output");
    const result = await parser.parse(ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toBe("no parser matched; returning tail + log path");
    expect(result.logPath).toBe(ctx.logPath);
  });

  it("long stdout → tail is bounded to last 200 lines", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    const ctx = makeCtx(lines.join("\n"));
    const result = await parser.parse(ctx);
    const tailLines = result.rawTail!.split("\n");
    expect(tailLines.length).toBeLessThanOrEqual(200);
    expect(tailLines[tailLines.length - 1]).toBe("line 300");
    expect(tailLines[0]).toBe("line 101");
  });
});
