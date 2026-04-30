import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

// Rust 1.73+: thread 'name' (optional-id) panicked at file:line:col:
//             message on following line(s)
const PANIC_NEW = /^thread '.+?' (?:\(\d+\) )?panicked at (.+?):(\d+):\d+:?$/;

// Pre-1.73: thread 'name' panicked at 'message', file:line:col
// Message may span multiple lines — use dotall flag
const PANIC_OLD = /thread '.+?' panicked at '(.*)', (.+?):(\d+):\d+/s;

// test result: FAILED. 1 passed; 2 failed; ...
const TEST_RESULT_RE = /^test result: \w+\. (\d+) passed; (\d+) failed/;

// ---- test::name stdout ----
const BLOCK_HEADER_RE = /^---- (.+) stdout ----$/;

const parser: ParserModule = {
  id: "cargo-test",
  async parse(ctx) {
    // Use combined log — test binary output goes to stdout, cargo progress to stderr;
    // reading both ensures we catch everything regardless of buffering order.
    const log = safeReadFile(ctx.logPath);
    const lines = log.split("\n").map((l) => l.trim());

    // If compilation failed there will be no "test result:" line
    const hasTestResult = lines.some((l) => TEST_RESULT_RE.test(l));
    if (!hasTestResult) {
      return {
        tool: "cargo",
        status: "error",
        summary: "compilation failed — run `cargo build --message-format=json` for structured errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    let passed = 0;
    let failed = 0;
    for (const line of lines) {
      const m = TEST_RESULT_RE.exec(line);
      if (m) {
        passed = Number(m[1]);
        failed = Number(m[2]);
      }
    }

    // Split into per-test failure blocks delimited by "---- test::name stdout ----" headers
    const blocks: Array<{ name: string; lines: string[] }> = [];
    let current: { name: string; lines: string[] } | null = null;

    for (const line of lines) {
      const headerMatch = BLOCK_HEADER_RE.exec(line);
      if (headerMatch) {
        if (current) blocks.push(current);
        current = { name: headerMatch[1], lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) blocks.push(current);

    const failures: ParsedFailure[] = blocks.map(({ name, lines: blockLines }) =>
      parseFailureBlock(name, blockLines, ctx.cwd)
    );

    return {
      tool: "cargo",
      status: failed > 0 ? "fail" : "pass",
      summary: failed > 0 ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

function parseFailureBlock(testName: string, lines: string[], cwd: string): ParsedFailure {
  let file: string | undefined;
  let lineNum: number | undefined;
  let message: string | undefined;

  // Try new format (1.73+) line by line first
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const newMatch = PANIC_NEW.exec(line);
    if (newMatch) {
      file = path.relative(cwd, path.resolve(cwd, newMatch[1]));
      lineNum = Number(newMatch[2]);
      // Collect message lines that follow until blank line or note:/error:
      const msgLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next === "" || next.startsWith("note:") || next.startsWith("error:")) break;
        msgLines.push(next);
      }
      message = formatMessage(msgLines);
      break;
    }
  }

  // Fall back to pre-1.73 format; join block so dotall regex handles multi-line messages
  if (!file) {
    const blockText = lines.join("\n");
    const oldMatch = PANIC_OLD.exec(blockText);
    if (oldMatch) {
      // Collapse internal newlines in message to a single space
      message = oldMatch[1].replace(/\s+/g, " ").trim();
      file = path.relative(cwd, path.resolve(cwd, oldMatch[2]));
      lineNum = Number(oldMatch[3]);
    }
  }

  const id = [file, lineNum, testName].filter(Boolean).join(":");
  return {
    id: id || testName,
    file,
    line: lineNum,
    message: message ?? testName,
  };
}

/** Compact assertion left/right onto one line; otherwise join with "; " */
function formatMessage(msgLines: string[]): string {
  if (msgLines.length === 0) return "";
  const main = msgLines[0];
  const leftLine = msgLines.find((l) => l.trimStart().startsWith("left:"));
  const rightLine = msgLines.find((l) => l.trimStart().startsWith("right:"));
  if (leftLine && rightLine) {
    return `${main}\n${leftLine.trim()}, ${rightLine.trim()}`;
  }
  return msgLines.filter(Boolean).join("; ");
}

export default parser;
