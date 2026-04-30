import path from "node:path";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface CargoSpan {
  file_name: string;
  line_start: number;
  is_primary: boolean;
  label: string | null;
}

interface CargoCode {
  code: string;
}

interface CargoMessage {
  message: string;
  level: string;
  code: CargoCode | null;
  spans: CargoSpan[];
}

interface CargoCompilerMessage {
  reason: "compiler-message";
  message: CargoMessage;
}

const parser: ParserModule = {
  id: "cargo-build",
  async parse(ctx) {
    // --message-format=json writes NDJSON to stdout; one JSON object per line
    const stdout = safeReadFile(ctx.stdoutPath);
    const failures: ParsedFailure[] = [];

    for (const line of stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let obj: Partial<CargoCompilerMessage>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.reason !== "compiler-message") continue;
      const msg = obj.message;
      if (!msg || msg.level !== "error") continue;

      const primarySpan = msg.spans?.find((s) => s.is_primary);
      const file = primarySpan ? path.relative(ctx.cwd, path.resolve(ctx.cwd, primarySpan.file_name)) : undefined;
      const lineNum = primarySpan?.line_start;
      const label = primarySpan?.label ?? undefined;
      const code = msg.code?.code;

      failures.push({
        id: [file, lineNum, code].filter(Boolean).join(":"),
        file,
        line: lineNum,
        // Surface the primary span label (e.g. "expected `i32`, found `&str`") as a second line
        message: label ? `${msg.message}\n${label}` : msg.message,
        rule: code,
      });
    }

    return {
      tool: "cargo",
      status: failures.length > 0 ? "fail" : "pass",
      summary: failures.length > 0 ? `${failures.length} error${failures.length === 1 ? "" : "s"}` : "build succeeded",
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
