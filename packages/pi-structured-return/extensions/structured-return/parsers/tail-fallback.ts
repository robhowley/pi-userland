import type { ParserModule } from "../types";
import { safeReadFile } from "./utils";

const parser: ParserModule = {
  id: "tail-fallback",
  async parse(ctx) {
    const log = safeReadFile(ctx.logPath);
    const lines = log.split(/\r?\n/);
    const tail = lines.slice(-200).join("\n");
    return {
      tool: "unknown",
      status: "error",
      summary: "no parser matched; returning tail + log path",
      logPath: ctx.logPath,
      rawTail: tail,
    };
  },
};

export default parser;
