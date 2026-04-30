import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// Summary lines: ℹ pass 1, ℹ fail 2
const SUMMARY_PASS = /^ℹ pass (\d+)/m;
const SUMMARY_FAIL = /^ℹ fail (\d+)/m;

// Failing test header: test at file:line:col
const TEST_AT_LINE = /^test at (.+?):(\d+):\d+/;

const parser: ParserModule = {
  id: "node-test-text",
  async parse(ctx) {
    const combined = safeReadFile(ctx.stdoutPath) + safeReadFile(ctx.stderrPath);
    if (!combined.trim()) {
      return {
        tool: "node:test",
        status: "pass",
        summary: "no tests found",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const passMatch = combined.match(SUMMARY_PASS);
    const failMatch = combined.match(SUMMARY_FAIL);
    const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : 0;

    // Parse the "failing tests:" section
    const failingSection = combined.split("✖ failing tests:")[1] ?? "";
    const failures: ParsedFailure[] = [];

    if (failingSection) {
      // Split into per-test blocks by "test at" lines
      const blocks = failingSection.split(/(?=^test at )/m).filter((b) => b.trim());

      for (const block of blocks) {
        const atMatch = block.match(TEST_AT_LINE);
        const nameMatch = block.match(/^✖ (.+?) \(/m);

        let file: string | undefined;
        let line: number | undefined;
        if (atMatch) {
          file = path.relative(ctx.cwd, atMatch[1]);
          line = parseInt(atMatch[2], 10);
        }

        const name = nameMatch ? nameMatch[1] : "unknown test";

        // Extract meaningful error message — try specific patterns first, then generic
        let message = name;
        const strictMatch = block.match(/Expected values to be strictly equal:\s*\n\s*\n\s*(.+)/);
        const falsyMatch = block.match(/The expression evaluated to a falsy value:\s*\n\s*\n\s*(.+)/);
        if (strictMatch) {
          message = `Expected values to be strictly equal: ${strictMatch[1].trim()}`;
        } else if (falsyMatch) {
          message = `The expression evaluated to a falsy value: ${falsyMatch[1].trim()}`;
        } else {
          // Match any Error type (AssertionError, TypeError, ReferenceError, etc.)
          const errorMatch = block.match(/^\s+(\w*Error\b.*?)$/m);
          if (errorMatch) message = errorMatch[1].replace(/\s*\[ERR_\w+\]:\s*/, ": ").replace(/^\w+Error: /, "");
        }

        failures.push({
          id: `${file}:${line}`,
          file,
          line,
          message,
        });
      }
    }

    const parts: string[] = [];
    if (failed > 0) parts.push(`${failed} failed`);
    if (passed > 0) parts.push(`${passed} passed`);
    const summary = parts.join(", ") || "tests completed";

    return {
      tool: "node:test",
      status: failed > 0 ? "fail" : "pass",
      summary,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
