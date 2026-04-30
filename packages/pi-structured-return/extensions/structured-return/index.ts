import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { globSync } from "glob";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { ObservedRunArgs, ParsedResult, RunContext } from "./types";
import { ensureRunDir, writeRunArtifacts } from "./storage/log-store";
import { loadProjectConfig } from "./config/project-config";
import { resolveParser, listParsers } from "./config/registry";
import { safeReadFile } from "./parsers/utils";
import { appendRun, readLifetimeStats, formatStatsBlock, type AggregatedStats } from "./storage/session-stats";

export default function structuredReturn(pi: ExtensionAPI) {
  pi.registerCommand("sr-parsers", {
    description: "List all structured-return parsers: built-ins and project-local registrations",
    handler: async (_args, ctx) => {
      const lines: string[] = ["structured-return parsers", ""];

      lines.push("built-in:");
      for (const { id, autoDetect } of listParsers()) {
        lines.push(`  ${id}${autoDetect ? "  (auto-detect)" : ""}`);
      }

      const projectRegistrations = loadProjectConfig(ctx.cwd);
      lines.push("");
      lines.push("project-local (.pi/structured-return.json):");
      if (projectRegistrations.length === 0) {
        lines.push("  (none)");
      } else {
        for (const reg of projectRegistrations) {
          const via = reg.parseAs ? `→ ${reg.parseAs}` : reg.module ? `→ module: ${reg.module}` : "";
          const match = reg.match?.argvIncludes
            ? `argv includes [${reg.match.argvIncludes.join(", ")}]`
            : reg.match?.regex
              ? `regex: ${reg.match.regex}`
              : "(no match rule)";
          lines.push(`  ${reg.id}  ${match}  ${via}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("sr-stats", {
    description: "Show token savings from structured-return (current session + cwd lifetime + lifetime)",
    handler: async (_args, ctx) => {
      const currentCwd = ctx.cwd ?? process.cwd();

      // Current session: walk session entries for our tool results
      const sessionStats: AggregatedStats = { runs: 0, rawBytes: 0, parsedBytes: 0 };
      try {
        const entries = ctx.sessionManager?.getEntries?.() ?? [];
        for (const entry of entries) {
          if (entry.type !== "message") continue;
          const msg = (
            entry as {
              message?: {
                role?: string;
                toolName?: string;
                details?: { rawBytes?: number; parsedBytes?: number };
              };
            }
          ).message;
          if (msg?.role !== "toolResult" || msg?.toolName !== "structured_return") continue;
          const details = msg.details;
          if (details?.rawBytes != null && details?.parsedBytes != null) {
            sessionStats.runs++;
            sessionStats.rawBytes += details.rawBytes;
            sessionStats.parsedBytes += details.parsedBytes;
          }
        }
      } catch {
        // session access may fail in some modes
      }

      const cwdLifetime = readLifetimeStats({ cwd: currentCwd });

      // Lifetime: read all JSONL files
      const lifetime = readLifetimeStats();

      const lines: string[] = ["structured-return stats", ""];
      lines.push(...formatStatsBlock("session", sessionStats));
      lines.push("");
      lines.push(...formatStatsBlock("cwd lifetime", cwdLifetime));
      lines.push("");
      lines.push(...formatStatsBlock("lifetime", lifetime));

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "structured_return",
    label: "Structured Return",
    description:
      "Run a command, store full logs, apply an explicit or registered parser when available, and fall back to tail + log path.",
    promptGuidelines: [
      "Prefer structured_return over bash for test suites, linters, type checkers, and build commands - it returns compact results. Check the structured-return skill for the right flags and parseAs value for each tool.",
    ],
    parameters: Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
      parseAs: Type.Optional(Type.String()),
      artifactPaths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(
      _toolCallId: string,
      args: ObservedRunArgs,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ) {
      const cwd = args.cwd ?? ctx.cwd ?? process.cwd();
      const runDir = ensureRunDir(cwd);
      const runId = randomUUID();
      const argv = shellSplit(args.command);
      const { stdout, stderr, exitCode } = await runCommand(args.command, cwd);
      const logs = writeRunArtifacts(runDir, runId, stdout, stderr);
      const artifactPaths = expandArtifactPaths(args.artifactPaths ?? [], cwd);
      const runCtx: RunContext = {
        command: args.command,
        argv,
        cwd,
        artifactPaths,
        ...logs,
      };
      const registrations = loadProjectConfig(cwd);
      const parser = await resolveParser({ cwd, parseAs: args.parseAs, argv, registrations });
      const parsed = await parser.parse(runCtx);
      const result = finalizeResult(parsed, exitCode, logs.logPath, cwd);
      const resultText = formatResult(result);

      const rawBytes = stdout.length + stderr.length;
      const parsedBytes = resultText.length;
      try {
        appendRun({
          ts: new Date().toISOString(),
          session: ctx.sessionManager?.getSessionFile?.() ?? undefined,
          parser: parser.id,
          rawBytes,
          parsedBytes,
          command: stripCdPrefix(args.command),
          cwd,
        });
      } catch {
        // stats are best-effort — never block the tool result
      }

      return {
        content: [{ type: "text" as const, text: `${stripCdPrefix(args.command)} → ${resultText}` }],
        details: { exitCode, logPath: logs.logPath, parser: parser.id, rawBytes, parsedBytes },
      };
    },
    renderCall(args: ObservedRunArgs) {
      return new Text(`structured_return ${args.command}`, 0, 0);
    },
    renderResult(result: { content?: Array<{ type: string; text?: string }> }) {
      const text = result?.content?.[0]?.text ?? "structured_return complete";
      return new Text(text, 0, 0);
    },
  });
}

export function formatResult(result: ParsedResult): string {
  const lines: string[] = [];
  if (result.cwd) lines.push(`cwd: ${result.cwd}`);
  lines.push(result.summary);
  for (const f of result.failures ?? []) {
    const location = [f.file, f.line].filter(Boolean).join(":");
    const rule = f.rule ? `  [${f.rule}]` : "";
    const msgLines = (f.message ?? "").split("\n");
    lines.push(`  ${location}  ${msgLines[0]}${rule}`);
    for (const extra of msgLines.slice(1)) lines.push(`    ${extra}`);
  }
  // If the parser detected failures but couldn't extract details, surface the
  // log path and raw tail so the model has a path forward instead of a dead end.
  if ((result.status === "fail" || result.status === "error") && (result.failures ?? []).length === 0) {
    if (result.logPath) lines.push(`log: ${result.logPath}`);
    if (result.rawTail) lines.push(result.rawTail);
  }
  return lines.join("\n");
}

/** Resolve and glob-expand artifact paths. Patterns that match nothing are kept as-is (parser handles missing files). */
export function expandArtifactPaths(raw: string[], cwd: string): string[] {
  return raw.flatMap((p) => {
    const resolved = path.isAbsolute(p) ? p : path.join(cwd, p);
    const expanded = globSync(resolved);
    return expanded.length > 0 ? expanded.sort() : [resolved];
  });
}

export function stripCdPrefix(command: string): string {
  return command.replace(/^cd\s+\S+\s*&&\s*/, "");
}

function shellSplit(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^['"]|['"]$/g, "")) ?? [];
}

function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

export function finalizeResult(
  result: Omit<ParsedResult, "exitCode">,
  exitCode: number,
  logPath: string,
  cwd: string
): ParsedResult {
  if (result.status === "error" && exitCode === 0) {
    return {
      ...result,
      exitCode,
      cwd,
      status: "pass",
      summary:
        result.summary === "no parser matched; returning tail + log path"
          ? "command completed; no parser matched"
          : result.summary,
      logPath,
    };
  }
  const finalized: ParsedResult = { ...result, exitCode, cwd, logPath };
  // Surface catastrophic failures (command not found, permission denied, missing
  // interpreter, etc.) — the combined log contains the actual diagnostic.
  if (finalized.status === "error" && exitCode !== 0 && !finalized.rawTail) {
    const log = safeReadFile(logPath);
    const lines = log.split(/\r?\n/);
    finalized.rawTail = lines.slice(-200).join("\n");
  }
  // Safety net: if the parser reports failures but couldn't extract any details
  // (e.g., tool output format changed), append the log tail so the model isn't
  // left with "2 failed" and nothing actionable.
  if (finalized.status === "fail" && (finalized.failures ?? []).length === 0 && !finalized.rawTail) {
    const log = safeReadFile(logPath);
    const lines = log.split(/\r?\n/);
    finalized.rawTail = lines.slice(-200).join("\n");
  }
  return finalized;
}
