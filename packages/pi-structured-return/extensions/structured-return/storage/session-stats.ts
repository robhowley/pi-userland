import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const FILE_PREFIX = "structured-return-stats.";
const FILE_SUFFIX = ".jsonl";
const MAX_FILE_BYTES = 3 * 1024 * 1024; // 3MB

function statsDir(): string {
  return path.join(os.homedir(), ".pi");
}

export type StatsEntry = {
  ts: string;
  session: string | undefined;
  parser: string;
  rawBytes: number;
  parsedBytes: number;
  command: string;
  cwd?: string;
};

export type AggregatedStats = {
  runs: number;
  rawBytes: number;
  parsedBytes: number;
};

function statsFileName(index: number): string {
  return `${FILE_PREFIX}${String(index).padStart(3, "0")}${FILE_SUFFIX}`;
}

function statsFilePath(index: number): string {
  return path.join(statsDir(), statsFileName(index));
}

/** Find all stats files sorted by index. */
function listStatsFiles(): string[] {
  const dir = statsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
    .sort();
  return files.map((f) => path.join(dir, f));
}

/** Get the current (latest) file index, creating 000 if none exist. */
function currentFileIndex(): number {
  const files = listStatsFiles();
  if (files.length === 0) return 0;
  const last = path.basename(files[files.length - 1]);
  const match = last.match(/\.(\d{3})\./);
  return match ? parseInt(match[1], 10) : 0;
}

/** Append a stats entry, spilling over to a new file if needed. */
export function appendRun(entry: StatsEntry): void {
  fs.mkdirSync(statsDir(), { recursive: true });
  let index = currentFileIndex();
  let filePath = statsFilePath(index);

  // Check spillover
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_FILE_BYTES) {
      index++;
      filePath = statsFilePath(index);
    }
  }

  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(filePath, line);
}

/** Read and aggregate all stats files for lifetime totals, optionally filtered by cwd. */
export function readLifetimeStats(opts: { cwd?: string } = {}): AggregatedStats {
  const files = listStatsFiles();
  const totals: AggregatedStats = { runs: 0, rawBytes: 0, parsedBytes: 0 };

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: StatsEntry = JSON.parse(line);
        if (opts.cwd && entry.cwd !== opts.cwd) continue;
        totals.runs++;
        totals.rawBytes += entry.rawBytes;
        totals.parsedBytes += entry.parsedBytes;
      } catch {
        // skip malformed lines
      }
    }
  }

  return totals;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Approximate token count: ~4 bytes per token for English text across common tokenizers (GPT/Claude). */
export function estimateTokens(bytes: number): string {
  const tokens = Math.round(bytes / 4);
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatStatsBlock(label: string, stats: AggregatedStats): string[] {
  const saved = stats.rawBytes - stats.parsedBytes;
  const pct = stats.rawBytes > 0 ? ((saved / stats.rawBytes) * 100).toFixed(1) : "0.0";
  return [
    `${label}:`,
    `  runs: ${stats.runs}`,
    `  raw output: ${formatBytes(stats.rawBytes)} (~${estimateTokens(stats.rawBytes)} tokens)`,
    `  parsed output: ${formatBytes(stats.parsedBytes)} (~${estimateTokens(stats.parsedBytes)} tokens)`,
    `  saved: ${formatBytes(saved)} (~${estimateTokens(saved)} tokens, ${pct}% reduction)`,
  ];
}
