import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendRun,
  readLifetimeStats,
  formatBytes,
  estimateTokens,
  formatStatsBlock,
  type StatsEntry,
} from "../../extensions/structured-return/storage/session-stats";

// Use a temp dir to avoid polluting ~/.pi during tests
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-stats-test-"));
  // Override homedir so statsDir() resolves to our temp
  vi.spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<StatsEntry> = {}): StatsEntry {
  return {
    ts: new Date().toISOString(),
    session: "/test/session.jsonl",
    parser: "vitest-json",
    rawBytes: 10000,
    parsedBytes: 200,
    command: "vitest run",
    ...overrides,
  };
}

describe("appendRun", () => {
  it("creates the stats file on first append", () => {
    appendRun(makeEntry());
    const file = path.join(tempDir, ".pi", "structured-return-stats.000.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).parser).toBe("vitest-json");
  });

  it("appends multiple entries to the same file", () => {
    appendRun(makeEntry({ command: "first" }));
    appendRun(makeEntry({ command: "second" }));
    appendRun(makeEntry({ command: "third" }));
    const file = path.join(tempDir, ".pi", "structured-return-stats.000.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).command).toBe("second");
  });

  it("spills over to a new file when current exceeds 3MB", () => {
    const statsDir = path.join(tempDir, ".pi");
    fs.mkdirSync(statsDir, { recursive: true });
    // Create a file just at the threshold
    const bigContent = "x".repeat(3 * 1024 * 1024);
    fs.writeFileSync(path.join(statsDir, "structured-return-stats.000.jsonl"), bigContent);

    appendRun(makeEntry());

    const newFile = path.join(statsDir, "structured-return-stats.001.jsonl");
    expect(fs.existsSync(newFile)).toBe(true);
    const lines = fs.readFileSync(newFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});

describe("readLifetimeStats", () => {
  it("returns zeros when no files exist", () => {
    const stats = readLifetimeStats();
    expect(stats).toEqual({ runs: 0, rawBytes: 0, parsedBytes: 0 });
  });

  it("sums entries across multiple files", () => {
    const statsDir = path.join(tempDir, ".pi");
    fs.mkdirSync(statsDir, { recursive: true });

    const entry1 = JSON.stringify({ rawBytes: 1000, parsedBytes: 100 });
    const entry2 = JSON.stringify({ rawBytes: 2000, parsedBytes: 200 });
    const entry3 = JSON.stringify({ rawBytes: 3000, parsedBytes: 300 });

    fs.writeFileSync(path.join(statsDir, "structured-return-stats.000.jsonl"), entry1 + "\n" + entry2 + "\n");
    fs.writeFileSync(path.join(statsDir, "structured-return-stats.001.jsonl"), entry3 + "\n");

    const stats = readLifetimeStats();
    expect(stats.runs).toBe(3);
    expect(stats.rawBytes).toBe(6000);
    expect(stats.parsedBytes).toBe(600);
  });

  it("skips malformed lines", () => {
    const statsDir = path.join(tempDir, ".pi");
    fs.mkdirSync(statsDir, { recursive: true });

    const content = [
      JSON.stringify({ rawBytes: 1000, parsedBytes: 100 }),
      "not valid json",
      JSON.stringify({ rawBytes: 2000, parsedBytes: 200 }),
    ].join("\n");
    fs.writeFileSync(path.join(statsDir, "structured-return-stats.000.jsonl"), content + "\n");

    const stats = readLifetimeStats();
    expect(stats.runs).toBe(2);
    expect(stats.rawBytes).toBe(3000);
  });

  it("can filter lifetime stats by cwd", () => {
    const statsDir = path.join(tempDir, ".pi");
    fs.mkdirSync(statsDir, { recursive: true });

    const content = [
      JSON.stringify({ rawBytes: 1000, parsedBytes: 100, cwd: "/repo/a" }),
      JSON.stringify({ rawBytes: 2000, parsedBytes: 200, cwd: "/repo/b" }),
      JSON.stringify({ rawBytes: 3000, parsedBytes: 300, cwd: "/repo/a" }),
    ].join("\n");
    fs.writeFileSync(path.join(statsDir, "structured-return-stats.000.jsonl"), content + "\n");

    const stats = readLifetimeStats({ cwd: "/repo/a" });
    expect(stats).toEqual({ runs: 2, rawBytes: 4000, parsedBytes: 400 });
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => expect(formatBytes(500)).toBe("500 B"));
  it("formats kilobytes", () => expect(formatBytes(2048)).toBe("2.0 KB"));
  it("formats megabytes", () => expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB"));
});

describe("estimateTokens", () => {
  it("formats small counts", () => expect(estimateTokens(100)).toBe("25"));
  it("formats thousands", () => expect(estimateTokens(40000)).toBe("10.0k"));
  it("formats millions", () => expect(estimateTokens(8000000)).toBe("2.0M"));
});

describe("formatStatsBlock", () => {
  it("formats a labeled stats block", () => {
    const block = formatStatsBlock("session", { runs: 5, rawBytes: 50000, parsedBytes: 1000 });
    expect(block[0]).toBe("session:");
    expect(block[1]).toContain("runs: 5");
    expect(block[4]).toContain("98.0% reduction");
  });

  it("handles zero runs gracefully", () => {
    const block = formatStatsBlock("lifetime", { runs: 0, rawBytes: 0, parsedBytes: 0 });
    expect(block[1]).toContain("runs: 0");
    expect(block[4]).toContain("0.0%");
  });
});
