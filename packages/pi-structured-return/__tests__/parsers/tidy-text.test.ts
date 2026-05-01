import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/tidy-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stderr: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tidy-test-"));
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stderrPath, stderr);
  return {
    command: "tidy -errors src/index.html",
    argv: ["tidy", "-errors", "src/index.html"],
    cwd,
    artifactPaths: [],
    stdoutPath: path.join(dir, "stdout"),
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("tidy-text parser", () => {
  it("warnings with remediation noise → strips advice, extracts line and message", async () => {
    const stderr = `line 1 column 1 - Warning: missing <!DOCTYPE> declaration
line 1 column 9 - Warning: inserting missing 'title' element
line 1 column 35 - Warning: <img> lacks "alt" attribute
Info: Document content looks like HTML 3.2
3 warnings, 0 errors were found!

The alt attribute should be used to give a short description
of an image; longer descriptions should be given with the
longdesc attribute which takes a URL linked to the description.
These measures are needed for people using non-graphical browsers.

For further advice on how to make your pages accessible
see http://www.w3.org/WAI/GL.

To learn more about HTML Tidy see http://tidy.sourceforge.net`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("3 warnings");
    expect(result.failures).toHaveLength(3);
    expect(result.failures![0].file).toBe("src/index.html");
    expect(result.failures![0].line).toBe(1);
    expect(result.failures![0].message).toBe("missing <!DOCTYPE> declaration");
    expect(result.failures![2].message).toBe('<img> lacks "alt" attribute');
    // No remediation text in failures
    expect(result.failures!.every((f) => !f.message!.includes("should be used"))).toBe(true);
  });

  it("errors and warnings → both counted in summary", async () => {
    const stderr = `line 1 column 1 - Error: unexpected end of file
line 1 column 1 - Warning: missing <!DOCTYPE> declaration
1 warning, 1 error were found!`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 error, 1 warning");
    expect(result.failures).toHaveLength(2);
  });

  it("no issues → status pass", async () => {
    const stderr = `No warnings or errors were found.`;
    const result = await parser.parse(makeCtx(stderr));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stderr → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });
});
