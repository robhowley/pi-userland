import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface DbtEvent {
  data: Record<string, unknown>;
  info: {
    name: string;
    level: string;
    msg: string;
  };
}

interface NodeInfo {
  node_name?: string;
  node_path?: string;
  node_status?: string;
}

/** Parse `PASS=2 WARN=1 ERROR=1 SKIP=0 TOTAL=4` from EndOfRunSummary msg */
function parseSummaryCounts(msg: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, key, val] of msg.matchAll(/(\w+)=(\d+)/g)) {
    counts[key] = Number(val);
  }
  return counts;
}

const parser: ParserModule = {
  id: "dbt-json",
  async parse(ctx) {
    // dbt --log-format json writes JSONL to stdout
    const raw = safeReadFile(ctx.stdoutPath);
    const events: DbtEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        events.push(JSON.parse(line) as DbtEvent);
      } catch {
        continue;
      }
    }

    const summary = events.find((e) => e.info.name === "EndOfRunSummary");
    const errors = events.filter((e) => e.info.name === "RunResultError");
    const warnings = events.filter((e) => e.info.name === "RunResultWarning");
    const compiled = events.filter((e) => e.info.name === "CompiledNode");

    // ---------- compile mode (no EndOfRunSummary, has CompiledNode) ----------
    if (compiled.length > 0 && !summary) {
      const names = compiled.map((n) => ((n.data.node_info ?? {}) as NodeInfo).node_name).filter(Boolean);
      const sqlParts = compiled
        .map((n) => {
          const info = (n.data.node_info ?? {}) as NodeInfo;
          const sql = n.data.compiled as string | undefined;
          return sql ? `-- ${info.node_name ?? "model"}\n${sql}` : undefined;
        })
        .filter(Boolean);
      return {
        tool: "dbt",
        status: "pass",
        summary: `compiled ${compiled.length} model${compiled.length === 1 ? "" : "s"}: ${names.join(", ")}`,
        failures: [],
        rawTail: sqlParts.join("\n\n"),
        logPath: ctx.logPath,
      };
    }

    // ---------- compile failure (no summary, no compiled nodes) ----------
    if (!summary && compiled.length === 0) {
      // Look for any error-level messages for context
      const errorMsgs = events.filter((e) => e.info.level === "error");
      const failures: ParsedFailure[] = errorMsgs.map((e, i) => ({
        id: String(i),
        message: e.info.msg,
      }));
      return {
        tool: "dbt",
        status: "error",
        summary: failures.length > 0 ? `${failures.length} error${failures.length === 1 ? "" : "s"}` : "failed",
        failures,
        logPath: ctx.logPath,
      };
    }

    // ---------- run / test mode ----------
    const counts = parseSummaryCounts(summary!.info.msg);
    const elapsed = (summary!.data.elapsed_time as number) ?? 0;
    const numErrors = counts.ERROR ?? (summary!.data.num_errors as number) ?? 0;
    const numWarnings = counts.WARN ?? (summary!.data.num_warnings as number) ?? 0;
    const numSkipped = counts.SKIP ?? (summary!.data.num_skipped as number) ?? 0;
    const numPassed = counts.PASS ?? 0;

    const failures: ParsedFailure[] = [];

    for (const err of errors) {
      const nodeInfo = (err.data.node_info ?? {}) as NodeInfo;
      failures.push({
        id: nodeInfo.node_name ?? String(failures.length),
        file: nodeInfo.node_path,
        message: (err.data.msg as string) ?? err.info.msg,
      });
    }

    for (const warn of warnings) {
      const nodeInfo = (warn.data.node_info ?? {}) as NodeInfo;
      failures.push({
        id: nodeInfo.node_name ?? String(failures.length),
        file: nodeInfo.node_path,
        message: `[warn] ${(warn.data.msg as string) ?? warn.info.msg}`,
      });
    }

    // Build summary string
    const parts: string[] = [];
    if (numErrors > 0) parts.push(`${numErrors} failed`);
    if (numPassed > 0) parts.push(`${numPassed} passed`);
    if (numWarnings > 0) parts.push(`${numWarnings} warning${numWarnings === 1 ? "" : "s"}`);
    if (numSkipped > 0) parts.push(`${numSkipped} skipped`);
    const summaryStr = `${parts.join(", ")} in ${elapsed.toFixed(2)}s`;

    return {
      tool: "dbt",
      status: numErrors > 0 ? "fail" : "pass",
      summary: summaryStr,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
