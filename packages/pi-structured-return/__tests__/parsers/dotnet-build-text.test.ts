import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/dotnet-build-text";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotnet-build-test-"));
  const stdoutPath = path.join(dir, "stdout");
  const stderrPath = path.join(dir, "stderr");
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, "");
  return {
    command: "dotnet build",
    argv: ["dotnet", "build"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath,
    logPath: path.join(dir, "log"),
  };
}

describe("dotnet-build-text parser", () => {
  it("duplicated errors → deduplicated, relative paths, rule code extracted", async () => {
    const cwd = "/project";
    const stdout = `  Determining projects to restore...
  All projects are up-to-date for restore.
/project/src/App.cs(7,25): error CS0029: Cannot implicitly convert type 'int' to 'string' [/project/src/App.csproj]
/project/src/App.cs(8,16): error CS0029: Cannot implicitly convert type 'string' to 'int' [/project/src/App.csproj]

Build FAILED.

/project/src/App.cs(7,25): error CS0029: Cannot implicitly convert type 'int' to 'string' [/project/src/App.csproj]
/project/src/App.cs(8,16): error CS0029: Cannot implicitly convert type 'string' to 'int' [/project/src/App.csproj]
    0 Warning(s)
    2 Error(s)

Time Elapsed 00:00:01.58`;
    const result = await parser.parse(makeCtx(stdout, cwd));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("2 errors");
    expect(result.failures).toHaveLength(2); // deduplicated from 4 lines
    expect(result.failures![0].file).toBe("src/App.cs");
    expect(result.failures![0].line).toBe(7);
    expect(result.failures![0].rule).toBe("CS0029");
  });

  it("no errors → status pass", async () => {
    const stdout = `  Determining projects to restore...
  All projects are up-to-date for restore.
  App -> /project/bin/Debug/net10.0/App.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)

Time Elapsed 00:00:01.00`;
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("build succeeded");
    expect(result.failures).toHaveLength(0);
  });

  it("empty stdout → no crash, status pass", async () => {
    const result = await parser.parse(makeCtx(""));
    expect(result.status).toBe("pass");
    expect(result.failures).toHaveLength(0);
  });

  it("single error → singular 'error' in summary", async () => {
    const stdout = `/project/a.cs(1,1): error CS0246: The type or namespace name 'Foo' could not be found [/project/a.csproj]

Build FAILED.

/project/a.cs(1,1): error CS0246: The type or namespace name 'Foo' could not be found [/project/a.csproj]
    0 Warning(s)
    1 Error(s)`;
    const result = await parser.parse(makeCtx(stdout));
    expect(result.status).toBe("fail");
    expect(result.summary).toBe("1 error");
    expect(result.failures).toHaveLength(1);
  });
});
