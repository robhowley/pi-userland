/**
 * Session Hygiene Helpers
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HealthLevel, SessionState, Thresholds } from "./types.js";

// ─── Constants ───

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "session-hygiene");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const PRESETS: Record<string, Thresholds> = {
  Conservative: {
    yellow: { cost: 2, context: 60_000 },
    red: { cost: 8, context: 120_000 },
  },
  Default: {
    yellow: { cost: 5, context: 100_000 },
    red: { cost: 15, context: 200_000 },
  },
  Relaxed: {
    yellow: { cost: 10, context: 150_000 },
    red: { cost: 25, context: 250_000 },
  },
};

// ─── Config Helpers ───

export function isValidThresholds(parsed: unknown): parsed is Thresholds {
  const p = parsed as Record<string, Record<string, unknown>>;
  const yc = p?.yellow?.cost;
  const yctx = p?.yellow?.context;
  const rc = p?.red?.cost;
  const rctx = p?.red?.context;

  if (typeof yc !== "number" || typeof yctx !== "number" || typeof rc !== "number" || typeof rctx !== "number") {
    return false;
  }

  if (yc <= 0 || yctx <= 0 || rc <= 0 || rctx <= 0) {
    return false;
  }

  if (yc >= rc) {
    return false;
  }

  if (yctx >= rctx) {
    return false;
  }

  return true;
}

export function loadConfig(): Thresholds {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return PRESETS.Default;
    }

    const data = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return isValidThresholds(parsed) ? parsed : PRESETS.Default;
  } catch {
    return PRESETS.Default;
  }
}

export function saveConfig(thresholds: Thresholds): boolean {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(thresholds, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ─── Cost Tracking ───

export function reconstructCost(ctx: ExtensionContext): number {
  let total = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    if (!entry.message || entry.message.role !== "assistant") continue;

    const msg = entry.message as AssistantMessage;
    const cost = msg?.usage?.cost?.total;
    if (typeof cost !== "number") continue;

    total += cost;
  }

  return total;
}

// ─── Health Computation ───

export function computeHealth(
  cost: number,
  contextTokens: number | null,
  thresholds: Thresholds,
): HealthLevel {
  if (cost >= thresholds.red.cost || (contextTokens !== null && contextTokens >= thresholds.red.context)) {
    return "red";
  }

  if (cost >= thresholds.yellow.cost || (contextTokens !== null && contextTokens >= thresholds.yellow.context)) {
    return "yellow";
  }

  return "green";
}

// ─── Status Indicator ───

export function formatCacheRate(inputTokens: number, cacheReadTokens: number): string | null {
  const total = inputTokens + cacheReadTokens;
  if (total === 0) return null;

  const rate = Math.round((cacheReadTokens / total) * 100);
  return `${rate}% cache`;
}

export function updateStatusIndicator(
  health: HealthLevel,
  ctx: Pick<ExtensionContext, "ui">,
  cacheStats: Pick<SessionState, "inputTokens" | "cacheReadTokens">,
) {
  const emoji = health === "green" ? "🟢" : health === "yellow" ? "🟡" : "🔴";
  const label = health === "green" ? "session healthy" : health === "yellow" ? "session growing" : "session critical";
  const cacheSuffix = formatCacheRate(cacheStats.inputTokens, cacheStats.cacheReadTokens);
  const status = cacheSuffix ? `${emoji} ${label} · ${cacheSuffix}` : `${emoji} ${label}`;

  ctx.ui.setStatus("session-hygiene", status);
}
