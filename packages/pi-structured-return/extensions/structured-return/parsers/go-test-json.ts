import fs from "node:fs";
import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";

interface GoTestEvent {
  Action: string;
  Package?: string;
  Test?: string;
  Output?: string;
  Elapsed?: number;
}

/** Extract file:line and message from a Go t.Error/t.Errorf output line. */
function parseTestOutput(output: string): { file?: string; line?: number; message?: string } | undefined {
  // Format: "    file.go:line: message"
  const m = output.match(/^\s+(\S+\.go):(\d+):\s+(.+)/);
  if (m) return { file: m[1], line: Number(m[2]), message: m[3].trim() };
  return undefined;
}

/** Extract panic message and user-code file:line from a stack trace. */
function parsePanic(
  outputs: string[],
  testName: string
): { message?: string; file?: string; line?: number } | undefined {
  const panicLine = outputs.find((o) => o.trim().startsWith("panic:"));
  if (!panicLine) return undefined;
  const message = panicLine
    .trim()
    .replace(/^panic:\s*/, "")
    .replace(/\s*\[.*\]$/, "")
    .trim();

  // Find the user code frame: "module.TestName(..." followed by "\tfile.go:line"
  for (let i = 0; i < outputs.length - 1; i++) {
    if (outputs[i].includes(`.${testName}(`)) {
      const m = outputs[i + 1].match(/\t([^\t]+\.go):(\d+)/);
      if (m) return { message, file: m[1], line: Number(m[2]) };
    }
  }
  return { message };
}

const parser: ParserModule = {
  id: "go-test-json",
  async parse(ctx) {
    const stdout = fs.readFileSync(ctx.stdoutPath, "utf8").trim();
    if (!stdout) {
      return { tool: "go test", status: "error", summary: "no output", logPath: ctx.logPath };
    }

    const events: GoTestEvent[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as GoTestEvent);
      } catch {
        // skip non-JSON lines
      }
    }

    // Collect outputs per test
    const testOutputs = new Map<string, string[]>();
    let passed = 0;
    let failed = 0;

    for (const e of events) {
      if (!e.Test) continue;
      if (e.Action === "output") {
        const outputs = testOutputs.get(e.Test) ?? [];
        outputs.push(e.Output ?? "");
        testOutputs.set(e.Test, outputs);
      } else if (e.Action === "pass") {
        passed++;
      } else if (e.Action === "fail") {
        failed++;
      }
    }

    const failures: ParsedFailure[] = [];
    for (const e of events) {
      if (e.Action !== "fail" || !e.Test) continue;
      const outputs = testOutputs.get(e.Test) ?? [];

      // Try parsing as a t.Error/t.Errorf output first
      let found = false;
      for (const o of outputs) {
        const parsed = parseTestOutput(o);
        if (parsed) {
          const relFile = parsed.file
            ? path.isAbsolute(parsed.file)
              ? path.relative(ctx.cwd, parsed.file)
              : parsed.file
            : undefined;
          failures.push({
            id: e.Test,
            file: relFile,
            line: parsed.line,
            message: parsed.message,
          });
          found = true;
          break;
        }
      }

      if (!found) {
        // Try parsing as a panic
        const panic = parsePanic(outputs, e.Test);
        if (panic) {
          const relFile = panic.file
            ? path.isAbsolute(panic.file)
              ? path.relative(ctx.cwd, panic.file)
              : panic.file
            : undefined;
          failures.push({
            id: e.Test,
            file: relFile,
            line: panic.line,
            message: panic.message ?? "panic",
          });
        } else {
          failures.push({ id: e.Test, message: "test failed" });
        }
      }
    }

    return {
      tool: "go test",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
