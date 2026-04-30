import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// unittest output blocks are separated by ======
// Each block starts with ERROR: or FAIL: line
// Then a Traceback with file:line, and the final line is the error/assertion message

const BLOCK_HEADER = /(ERROR|FAIL):\s+(\S+)\s+\(([^)]+)\)/;
const FILE_LINE = /File\s+"([^"]+)",\s+line\s+(\d+)/;

const parser: ParserModule = {
  id: "unittest-text",
  async parse(ctx) {
    // Python unittest writes all output (results, tracebacks, summary) to stderr.
    const stderr = safeReadFile(ctx.stderrPath).trim();
    if (!stderr) {
      return { tool: "unittest", status: "pass", summary: "no output", failures: [], logPath: ctx.logPath };
    }

    // Parse the summary line: "Ran N tests in Xs" and "FAILED (failures=N, errors=N)" or "OK"
    const ranMatch = stderr.match(/Ran\s+(\d+)\s+test/);
    const totalTests = ranMatch ? Number(ranMatch[1]) : 0;
    // Parse skipped count from "FAILED (failures=N, skipped=N)" or "OK (skipped=N)"
    const skippedMatch = stderr.match(/skipped=(\d+)/);
    const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;
    const isOk = stderr.includes("\nOK");

    if (isOk) {
      const passed = totalTests - skipped;
      return {
        tool: "unittest",
        status: "pass",
        summary: `${passed} passed`,
        failures: [],
        logPath: ctx.logPath,
      };
    }

    // Split into blocks by the ====== separator
    const blocks = stderr.split(/={50,}/);
    const failures: ParsedFailure[] = [];

    for (const block of blocks) {
      const headerMatch = block.match(BLOCK_HEADER);
      if (!headerMatch) continue;

      const [, kind, testName] = headerMatch;
      const lines = block.split("\n");

      // Find the last File "..." line in the traceback (the user code, not framework)
      let file: string | undefined;
      let line: number | undefined;
      for (const l of lines) {
        const fm = l.match(FILE_LINE);
        if (fm) {
          file = fm[1];
          line = Number(fm[2]);
        }
      }

      // The error message is the last non-empty line of the traceback block.
      // Stop at dashed separators (------) that come AFTER the traceback,
      // summary lines ("Ran N tests"), or FAILED/OK lines.
      const traceLines: string[] = [];
      let pastHeader = false;
      for (const l of lines) {
        const trimmed = l.trim();
        if (!pastHeader) {
          // Skip until we're past the initial header + first dashed separator
          if (/^-{10,}/.test(trimmed)) {
            pastHeader = true;
          }
          continue;
        }
        // Stop at the next dashed separator (before summary) or summary lines
        if (/^-{10,}/.test(trimmed)) break;
        if (/^Ran\s+\d+\s+test/.test(trimmed)) break;
        if (/^(FAILED|OK)/.test(trimmed)) break;
        traceLines.push(trimmed);
      }
      const nonEmpty = traceLines.filter(Boolean);
      const errorLine = nonEmpty[nonEmpty.length - 1] ?? "test failed";

      // For assertions, extract expected/actual from "AssertionError: X != Y"
      let message = errorLine;
      const assertMatch = errorLine.match(/AssertionError:\s*(.+)/);
      if (assertMatch) {
        message = assertMatch[1];
      }

      const relFile = file ? (path.isAbsolute(file) ? path.relative(ctx.cwd, file) : file) : undefined;

      failures.push({
        id: `${testName}`,
        file: relFile,
        line,
        message,
        rule: kind === "ERROR" ? "error" : "assertion",
      });
    }

    const failed = failures.length;
    const passed = totalTests - failed - skipped;

    return {
      tool: "unittest",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
