import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/vale-json";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vale-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "vale --output JSON .",
    argv: ["vale", "--output", "JSON", "."],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

describe("vale-json parser", () => {
  it("multiple errors across files → correct relative paths, rule names, severity summary", async () => {
    const cwd = "/project";
    const stdout = JSON.stringify({
      "/project/docs/readme.md": [
        {
          Line: 3,
          Message: "Did you really mean 'writen'?",
          Severity: "error",
          Check: "Vale.Spelling",
          Action: { Name: "suggest", Params: ["spellings"] },
          Span: [57, 62],
        },
        {
          Line: 5,
          Message: "Use 'basically' instead of 'basicly'.",
          Severity: "warning",
          Check: "Vale.Terms",
          Action: { Name: "replace", Params: ["basically"] },
          Span: [10, 17],
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 error, 1 warning");
    expect(result.failures).toHaveLength(2);
    expect(result.failures![0].file).toBe("docs/readme.md");
    expect(result.failures![0].rule).toBe("Vale.Spelling");
    expect(result.failures![1].rule).toBe("Vale.Terms");
  });

  it("warnings only → status pass (no errors)", async () => {
    const stdout = JSON.stringify({
      "/project/doc.md": [
        {
          Line: 1,
          Message: "Consider using active voice.",
          Severity: "warning",
          Check: "Vale.Passive",
          Action: {},
          Span: [1, 10],
        },
      ],
    });
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("1 warning");
  });

  it("no alerts → status pass", async () => {
    const result = await parser.parse(makeCtx(JSON.stringify({})));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("no prose issues");
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
