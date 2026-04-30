import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { extractJsStackLocation, safeReadFile } from "./utils";

/**
 * Parses AVA's default text output (--no-color).
 * Reads stdoutPath — AVA writes all output (results + diagnostics) to stdout.
 */

// Summary line: "2 tests failed" or "3 tests passed"
const SUMMARY_RE = /(\d+) tests? (passed|failed)/g;

// Failure header in the results area: "✘ [fail]: <name>"
const FAIL_MARKER_RE = /^\s*✘\s+\[fail\]:\s+(.+?)(?:\s+Error thrown in test)?$/;

const parser: ParserModule = {
  id: "ava-text",
  async parse(ctx) {
    const stderr = safeReadFile(ctx.stdoutPath);
    if (!stderr.trim()) {
      return { tool: "ava", status: "error", summary: "no output", logPath: ctx.logPath };
    }

    // Extract pass/fail counts from summary lines at the end
    let passed = 0;
    let failed = 0;
    let m: RegExpExecArray | null;
    while ((m = SUMMARY_RE.exec(stderr)) !== null) {
      const count = parseInt(m[1], 10);
      if (m[2] === "passed") passed = count;
      else failed = count;
    }

    if (passed === 0 && failed === 0) {
      return { tool: "ava", status: "error", summary: "could not parse ava output", logPath: ctx.logPath };
    }

    const failures = parseFailureBlocks(stderr, ctx.cwd);

    return {
      tool: "ava",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;

/**
 * AVA's failure detail section lives between the first and last ─ separators.
 * Each failure block starts with the test name (matching a name from the ✘ lines),
 * followed by either a file:line (assertion) or "Error thrown in test:" (runtime).
 *
 * Strategy: collect failed test names from ✘ lines, then split the detail section
 * by those names to get per-failure blocks.
 */
function parseFailureBlocks(output: string, cwd: string): ParsedFailure[] {
  const lines = output.split("\n");

  // Collect failed test names from ✘ markers
  const failedNames: string[] = [];
  for (const line of lines) {
    const fm = FAIL_MARKER_RE.exec(line);
    if (fm) failedNames.push(fm[1]);
  }

  if (failedNames.length === 0) return [];

  // Find the detail section between first and last ─ separators
  const sepIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^\s*─\s*$/)) sepIndices.push(i);
  }
  if (sepIndices.length < 2) return [];

  const detailStart = sepIndices[0] + 1;
  const detailEnd = sepIndices[sepIndices.length - 1];
  const detailLines = lines.slice(detailStart, detailEnd);

  // Split detail lines into blocks by test name
  const blocks: Array<{ name: string; lines: string[] }> = [];
  let currentBlock: { name: string; lines: string[] } | null = null;

  for (const line of detailLines) {
    const trimmed = line.trim();
    if (failedNames.includes(trimmed)) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = { name: trimmed, lines: [] };
    } else if (currentBlock) {
      currentBlock.lines.push(line);
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  // Parse each block
  return blocks.map((block) => parseBlock(block.name, block.lines, cwd));
}

function parseBlock(name: string, lines: string[], cwd: string): ParsedFailure {
  // Determine type by looking for "Error thrown in test:"
  const isRuntimeError = lines.some((l) => l.trim() === "Error thrown in test:");

  if (isRuntimeError) {
    return parseRuntimeError(name, lines, cwd);
  }
  return parseAssertionFailure(name, lines, cwd);
}

function parseAssertionFailure(name: string, lines: string[], cwd: string): ParsedFailure {
  let file: string | undefined;
  let line: number | undefined;
  let actual: string | undefined;
  let expected: string | undefined;

  for (const l of lines) {
    const trimmed = l.trim();

    // file:line (standalone, e.g. "test_math.js:8")
    if (!file) {
      const flm = trimmed.match(/^(.+\.[a-z]{1,4}):(\d+)$/);
      if (flm) {
        file = path.relative(cwd, path.resolve(cwd, flm[1]));
        line = parseInt(flm[2], 10);
        continue;
      }
    }

    // Diff values: "- 12" (actual), "+ 99" (expected)
    if (trimmed.startsWith("- ") && actual === undefined) {
      actual = trimmed.slice(2);
    } else if (trimmed.startsWith("+ ") && expected === undefined) {
      expected = trimmed.slice(2);
    }
  }

  const message = actual !== undefined && expected !== undefined ? `expected ${expected}, got ${actual}` : undefined;

  return { id: name, file, line, message };
}

function parseRuntimeError(name: string, lines: string[], cwd: string): ParsedFailure {
  let message: string | undefined;

  for (const l of lines) {
    const trimmed = l.trim();
    // Extract message from "message: '...'" inside the error object
    if (!message) {
      const msgMatch = trimmed.match(/^message:\s*'(.+)',?$/);
      if (msgMatch) message = msgMatch[1];
    }
  }

  // Extract file:line from the first user stack frame
  const loc = extractJsStackLocation(lines.join("\n"));
  const file = loc.file ? path.relative(cwd, path.resolve(cwd, loc.file)) : undefined;

  return { id: name, file, line: loc.line, message };
}
