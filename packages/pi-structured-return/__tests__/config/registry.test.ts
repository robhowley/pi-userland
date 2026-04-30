import { describe, it, expect } from "vitest";
import { resolveParser } from "../../extensions/structured-return/config/registry";

/** Resolve a parser from argv with no explicit parseAs or project registrations. */
async function detect(argv: string[]) {
  const parser = await resolveParser({ cwd: "/project", argv, registrations: [] });
  return parser.id;
}

describe("resolveParser priority", () => {
  it("explicit parseAs wins over auto-detect", async () => {
    // argv would auto-detect as ruff-json, but parseAs overrides
    const parser = await resolveParser({
      cwd: "/project",
      parseAs: "eslint-json",
      argv: ["ruff", "check", "--output-format=json"],
      registrations: [],
    });
    expect(parser.id).toBe("eslint-json");
  });

  it("project registration wins over auto-detect", async () => {
    const parser = await resolveParser({
      cwd: "/project",
      argv: ["ruff", "check", "--output-format=json"],
      registrations: [{ id: "custom", match: { argvIncludes: ["ruff"] }, parseAs: "eslint-json" }],
    });
    expect(parser.id).toBe("eslint-json");
  });

  it("falls back to tail-fallback when nothing matches", async () => {
    const parser = await resolveParser({ cwd: "/project", argv: ["unknown-tool"], registrations: [] });
    expect(parser.id).toBe("tail-fallback");
  });
});

describe("AUTO_DETECT", () => {
  describe("hasFlag correctness — no false positives from bare value tokens", () => {
    it("eslint -f json matches", async () => {
      expect(await detect(["eslint", "src/", "-f", "json"])).toBe("eslint-json");
    });

    it("eslint without -f json does not match", async () => {
      expect(await detect(["eslint", "src/"])).toBe("tail-fallback");
    });

    it("ruff --output-format=json (joined) matches", async () => {
      expect(await detect(["ruff", "check", "--output-format=json"])).toBe("ruff-json");
    });

    it("ruff --output-format json (split) matches", async () => {
      expect(await detect(["ruff", "check", "--output-format", "json"])).toBe("ruff-json");
    });

    it("ruff without --output-format does not match", async () => {
      expect(await detect(["ruff", "check"])).toBe("tail-fallback");
    });

    it("mocha --reporter=json matches", async () => {
      expect(await detect(["mocha", "--reporter=json"])).toBe("mocha-json");
    });

    it("mocha --reporter json (split) matches", async () => {
      expect(await detect(["mocha", "--reporter", "json"])).toBe("mocha-json");
    });

    it("mocha with json in path does NOT false-positive", async () => {
      expect(await detect(["mocha", "test/json/"])).toBe("tail-fallback");
    });

    it("rubocop --format=json matches", async () => {
      expect(await detect(["rubocop", "--format=json"])).toBe("rubocop-json");
    });

    it("rubocop --format progress does NOT false-positive", async () => {
      expect(await detect(["rubocop", "--format", "progress"])).toBe("tail-fallback");
    });

    it("hadolint --format json (split) matches", async () => {
      expect(await detect(["hadolint", "--format", "json", "Dockerfile"])).toBe("hadolint-json");
    });

    it("hadolint without --format does NOT match", async () => {
      expect(await detect(["hadolint", "Dockerfile"])).toBe("tail-fallback");
    });

    it("tsc --pretty false (split) matches", async () => {
      expect(await detect(["tsc", "--pretty", "false"])).toBe("tsc-text");
    });

    it("tsc --pretty=false (joined) matches", async () => {
      expect(await detect(["tsc", "--pretty=false"])).toBe("tsc-text");
    });

    it("tsc without --pretty does NOT match", async () => {
      expect(await detect(["tsc"])).toBe("tail-fallback");
    });

    it("mypy --output=json matches", async () => {
      expect(await detect(["mypy", "--output=json", "src/"])).toBe("mypy-json");
    });

    it("mypy --output html does NOT false-positive", async () => {
      expect(await detect(["mypy", "--output", "html", "src/"])).toBe("tail-fallback");
    });

    it("pylint --output-format=json matches", async () => {
      expect(await detect(["pylint", "--output-format=json", "src/"])).toBe("pylint-json");
    });

    it("shellcheck --format=json matches", async () => {
      expect(await detect(["shellcheck", "--format=json", "script.sh"])).toBe("shellcheck-json");
    });

    it("stylelint --formatter=json matches", async () => {
      expect(await detect(["stylelint", "--formatter=json", "src/"])).toBe("stylelint-json");
    });

    it("dbt run --log-format=json matches", async () => {
      expect(await detect(["dbt", "run", "--log-format=json"])).toBe("dbt-json");
    });

    it("dbt run --log-format json (split) matches", async () => {
      expect(await detect(["dbt", "run", "--log-format", "json"])).toBe("dbt-json");
    });

    it("dbt run without --log-format does NOT match", async () => {
      expect(await detect(["dbt", "run"])).toBe("tail-fallback");
    });
  });

  describe("remaining flag-based detectors", () => {
    it("rspec --format=json matches", async () => {
      expect(await detect(["rspec", "--format=json"])).toBe("rspec-json");
    });

    it("cargo build --message-format=json matches", async () => {
      expect(await detect(["cargo", "build", "--message-format=json"])).toBe("cargo-build");
    });

    it("pytest --junitxml matches junit-xml", async () => {
      expect(await detect(["pytest", "--junitxml=report.xml"])).toBe("junit-xml");
    });
  });

  describe("non-flag-based detectors still work", () => {
    it("cargo test matches", async () => {
      expect(await detect(["cargo", "test"])).toBe("cargo-test");
    });

    it("go test -json matches", async () => {
      expect(await detect(["go", "test", "-json", "./..."])).toBe("go-test-json");
    });

    it("ava matches", async () => {
      expect(await detect(["ava"])).toBe("ava-text");
    });

    it("swiftc -typecheck matches", async () => {
      expect(await detect(["swiftc", "-typecheck", "main.swift"])).toBe("swiftc-text");
    });

    it("python3 -m unittest matches", async () => {
      expect(await detect(["python3", "-m", "unittest"])).toBe("unittest-text");
    });

    it("vitest --reporter=json matches", async () => {
      expect(await detect(["vitest", "run", "--reporter=json"])).toBe("vitest-json");
    });
  });
});
