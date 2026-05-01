import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/dbt-json";
import type { RunContext } from "../../extensions/structured-return/types";

const SAMPLES_DIR = path.resolve(__dirname, "../../benchmarks/pipeline-tools/dbt");

function makeCtx(stdout: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-test-"));
  const stdoutPath = path.join(dir, "stdout");
  fs.writeFileSync(stdoutPath, stdout);
  return {
    command: "dbt run --log-format json",
    argv: ["dbt", "run", "--log-format", "json"],
    cwd,
    artifactPaths: [],
    stdoutPath,
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

function loadSample(filename: string): string {
  return fs.readFileSync(path.join(SAMPLES_DIR, filename), "utf8");
}

describe("dbt-json parser", () => {
  describe("dbt run success", () => {
    it("3 models pass → status pass, correct summary, no failures", async () => {
      const result = await parser.parse(makeCtx(loadSample("dbt-run-success.jsonl")));
      expect(result.status).toBe("pass");
      expect(result.summary).toBe("3 passed in 34.22s");
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("dbt run failure", () => {
    it("2 errors, 1 skip → status fail, both errors surfaced with node name and path", async () => {
      const result = await parser.parse(makeCtx(loadSample("dbt-run-failure.jsonl")));
      expect(result.status).toBe("fail");
      expect(result.summary).toMatch(/2 failed/);
      expect(result.summary).toMatch(/1 passed/);
      expect(result.summary).toMatch(/1 skipped/);
      expect(result.summary).toMatch(/34\.22s/);
      expect(result.failures).toHaveLength(2);

      const dbErr = result.failures![0];
      expect(dbErr.id).toBe("mart__core__daily_active_customers");
      expect(dbErr.file).toBe("models/mart/core/mart__core__daily_active_customers.sql");
      expect(dbErr.message).toMatch(/Column customer_id in USING clause not found/);

      const rtErr = result.failures![1];
      expect(rtErr.id).toBe("mart__core__daily_summary");
      expect(rtErr.file).toBe("models/mart/core/mart__core__daily_summary.sql");
      expect(rtErr.message).toMatch(/Access Denied/);
    });
  });

  describe("dbt test failure", () => {
    it("2 errors → status fail, both errors surfaced", async () => {
      const result = await parser.parse(makeCtx(loadSample("dbt-test-failure.jsonl")));
      expect(result.status).toBe("fail");
      expect(result.summary).toMatch(/2 failed/);
      expect(result.summary).toMatch(/1 passed/);
      expect(result.failures).toHaveLength(2);
    });

    it("uniqueness test failure has result count in message", async () => {
      const result = await parser.parse(makeCtx(loadSample("dbt-test-failure.jsonl")));
      const uniqueTest = result.failures!.find((f) => f.id.includes("unique_"));
      expect(uniqueTest).toBeDefined();
      expect(uniqueTest!.message).toMatch(/Got 3 results/);
      expect(uniqueTest!.file).toBe("models/mart/core/_core__models.yml");
    });

    it("unit test failure preserves actual/expected diff table", async () => {
      const result = await parser.parse(makeCtx(loadSample("dbt-test-failure.jsonl")));
      const unitTest = result.failures!.find((f) => f.id.includes("unit_test"));
      expect(unitTest).toBeDefined();
      expect(unitTest!.message).toMatch(/actual differs from expected/);
      expect(unitTest!.message).toMatch(/engagement_score/);
      expect(unitTest!.message).toMatch(/85\.5/);
      expect(unitTest!.message).toMatch(/90\.0/);
    });

    it("warnings are included with [warn] prefix when present", async () => {
      // Inline JSONL with a warning event
      const jsonl = [
        JSON.stringify({
          data: {
            msg: "Got 12 results, configured to warn if != 0",
            node_info: { node_name: "relationships_test", node_path: "models/test.yml", node_status: "warn" },
          },
          info: { name: "RunResultWarning", level: "warn", msg: "Got 12 results" },
        }),
        JSON.stringify({
          data: { elapsed_time: 5.0, num_errors: 0, num_warnings: 1, num_skipped: 0 },
          info: { name: "EndOfRunSummary", level: "info", msg: "Done. PASS=2 WARN=1 ERROR=0 SKIP=0 TOTAL=3" },
        }),
      ].join("\n");
      const result = await parser.parse(makeCtx(jsonl));
      expect(result.status).toBe("pass");
      const warning = result.failures!.find((f) => f.id === "relationships_test");
      expect(warning).toBeDefined();
      expect(warning!.message).toMatch(/^\[warn\]/);
    });
  });

  describe("dbt compile success", () => {
    it("3 models compiled, all SQL returned in rawTail", async () => {
      const result = await parser.parse(makeCtx(loadSample("dbt-compile.jsonl")));
      expect(result.status).toBe("pass");
      expect(result.summary).toMatch(/compiled 3 models/);
      expect(result.summary).toMatch(/mart__core__customer_engagement/);
      expect(result.summary).toMatch(/mart__core__daily_summary/);
      expect(result.failures).toHaveLength(0);
      expect(result.rawTail).toBeDefined();
      expect(result.rawTail).toMatch(/WITH user_events AS/);
      expect(result.rawTail).toMatch(/-- mart__core__daily_active_customers/);
      expect(result.rawTail).toMatch(/-- mart__core__daily_summary/);
    });
  });

  describe("dbt compile failure", () => {
    it("no summary + no compiled nodes → status error", async () => {
      // Simulate a compile failure: error-level message, no EndOfRunSummary, no CompiledNode
      const jsonl = [
        JSON.stringify({
          data: {},
          info: { name: "MainReportVersion", level: "info", msg: "Running with dbt=1.8.4" },
        }),
        JSON.stringify({
          data: {},
          info: {
            name: "CompilationError",
            level: "error",
            msg: "Compilation Error in model mart__core__customer_engagement (models/mart/core/mart__core__customer_engagement.sql)\n  Model 'ref(\"stg__missing_model\")' was not found",
          },
        }),
      ].join("\n");

      const result = await parser.parse(makeCtx(jsonl));
      expect(result.status).toBe("error");
      expect(result.summary).toBe("1 error");
      expect(result.failures).toHaveLength(1);
      expect(result.failures![0].message).toMatch(/stg__missing_model/);
    });
  });

  describe("empty / malformed input", () => {
    it("empty stdout → error status, no crash", async () => {
      const result = await parser.parse(makeCtx(""));
      expect(result.status).toBe("error");
      expect(result.failures).toHaveLength(0);
    });

    it("non-JSON lines are skipped gracefully", async () => {
      const input =
        "some garbage\n" +
        JSON.stringify({
          data: { elapsed_time: 1.0, num_errors: 0, num_warnings: 0, num_skipped: 0 },
          info: { name: "EndOfRunSummary", level: "info", msg: "Done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1" },
        }) +
        "\nmore garbage";
      const result = await parser.parse(makeCtx(input));
      expect(result.status).toBe("pass");
      expect(result.summary).toBe("1 passed in 1.00s");
    });
  });
});
