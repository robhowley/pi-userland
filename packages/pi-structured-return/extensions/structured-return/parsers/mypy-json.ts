import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface MypyItem {
  file: string;
  line: number;
  column: number;
  message: string;
  hint: string | null;
  code: string | null;
  severity: "error" | "note";
}

const parser: ParserModule = {
  id: "mypy-json",
  async parse(ctx) {
    // mypy --output json writes JSON diagnostics to stderr (stdout gets the human summary).
    const stderr = safeReadFile(ctx.stderrPath).trim();
    if (!stderr) {
      return {
        tool: "mypy",
        status: "pass",
        summary: "no type errors",
        failures: [],
        logPath: ctx.logPath,
      };
    }

    const items: MypyItem[] = [];
    for (const line of stderr.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed) as MypyItem);
      } catch {
        // skip non-JSON lines (e.g. summary text on stderr)
      }
    }

    const errors = items.filter((item) => item.severity === "error");
    // Build a map of notes keyed by normalized relative path:line so lookups
    // match regardless of whether mypy emits absolute or relative paths.
    const relPathOf = (f: string) => (path.isAbsolute(f) ? path.relative(ctx.cwd, f) : f);
    const notesByLocation = new Map<string, string[]>();
    for (const item of items) {
      if (item.severity === "note") {
        const key = `${relPathOf(item.file)}:${item.line}`;
        const notes = notesByLocation.get(key) ?? [];
        notes.push(item.message);
        notesByLocation.set(key, notes);
      }
    }

    const failures: ParsedFailure[] = errors.map((item) => {
      const relPath = relPathOf(item.file);
      const key = `${relPath}:${item.line}`;
      const notes = notesByLocation.get(key);
      const hint = item.hint ?? (notes ? notes.join("; ") : undefined);
      const message = hint ? `${item.message} (${hint})` : item.message;
      return {
        id: `${relPath}:${item.line}:${item.code ?? "error"}`,
        file: relPath,
        line: item.line,
        message,
        rule: item.code ?? undefined,
      };
    });

    return {
      tool: "mypy",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} type errors` : "no type errors",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
