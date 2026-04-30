import path from "node:path";
import type { ParserModule, ParserRegistration } from "../types";
import ruffJson from "../parsers/ruff-json";
import eslintJson from "../parsers/eslint-json";
import vitestJson from "../parsers/vitest-json";
import rspecJson from "../parsers/rspec-json";
import minitestText from "../parsers/minitest-text";
import junitXml from "../parsers/junit-xml";
import cargoBuild from "../parsers/cargo-build";
import cargoTest from "../parsers/cargo-test";
import dbtJson from "../parsers/dbt-json";
import mypyJson from "../parsers/mypy-json";
import tscText from "../parsers/tsc-text";
import pylintJson from "../parsers/pylint-json";
import shellcheckJson from "../parsers/shellcheck-json";
import rubocopJson from "../parsers/rubocop-json";
import swiftcText from "../parsers/swiftc-text";
import hadolintJson from "../parsers/hadolint-json";
import stylelintJson from "../parsers/stylelint-json";
import mochaJson from "../parsers/mocha-json";
import unittestText from "../parsers/unittest-text";
import goTestJson from "../parsers/go-test-json";
import avaText from "../parsers/ava-text";
import pyrightJson from "../parsers/pyright-json";
import banditJson from "../parsers/bandit-json";
import javacText from "../parsers/javac-text";
import dotnetBuildText from "../parsers/dotnet-build-text";
import clangText from "../parsers/clang-text";
import nodeTestText from "../parsers/node-test-text";
import blackText from "../parsers/black-text";
import markdownlintJson from "../parsers/markdownlint-json";
import prettierText from "../parsers/prettier-text";
import valeJson from "../parsers/vale-json";
import tidyText from "../parsers/tidy-text";
import jsonlintText from "../parsers/jsonlint-text";
import npmAuditJson from "../parsers/npm-audit-json";
import isortText from "../parsers/isort-text";
import htmlhintJson from "../parsers/htmlhint-json";
import tailFallback from "../parsers/tail-fallback";

const builtIns: Record<string, ParserModule> = {
  "ruff-json": ruffJson,
  "eslint-json": eslintJson,
  "vitest-json": vitestJson,
  "rspec-json": rspecJson,
  "minitest-text": minitestText,
  "junit-xml": junitXml,
  "cargo-build": cargoBuild,
  "cargo-test": cargoTest,
  "dbt-json": dbtJson,
  "mypy-json": mypyJson,
  "tsc-text": tscText,
  "pylint-json": pylintJson,
  "shellcheck-json": shellcheckJson,
  "rubocop-json": rubocopJson,
  "swiftc-text": swiftcText,
  "hadolint-json": hadolintJson,
  "stylelint-json": stylelintJson,
  "mocha-json": mochaJson,
  "unittest-text": unittestText,
  "go-test-json": goTestJson,
  "ava-text": avaText,
  "pyright-json": pyrightJson,
  "bandit-json": banditJson,
  "javac-text": javacText,
  "dotnet-build-text": dotnetBuildText,
  "clang-text": clangText,
  "node-test-text": nodeTestText,
  "black-text": blackText,
  "markdownlint-json": markdownlintJson,
  "prettier-text": prettierText,
  "vale-json": valeJson,
  "tidy-text": tidyText,
  "jsonlint-text": jsonlintText,
  "npm-audit-json": npmAuditJson,
  "isort-text": isortText,
  "htmlhint-json": htmlhintJson,
  "tail-fallback": tailFallback,
};

/**
 * Check whether argv contains `--flag=value` (joined) or `--flag value` (adjacent).
 * Avoids false positives from bare `value` tokens appearing elsewhere in argv.
 */
function hasFlag(argv: string[], flag: string, value: string): boolean {
  if (argv.includes(`${flag}=${value}`)) return true;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === value) return true;
  }
  return false;
}

/** Built-in detection patterns — fire when no explicit parseAs or project registration matched. */
const AUTO_DETECT: Array<{ parserId: string; detect: (argv: string[]) => boolean }> = [
  {
    parserId: "eslint-json",
    detect: (argv) => argv.includes("eslint") && hasFlag(argv, "-f", "json"),
  },
  {
    parserId: "ruff-json",
    detect: (argv) => argv.includes("ruff") && hasFlag(argv, "--output-format", "json"),
  },
  {
    parserId: "vitest-json",
    detect: (argv) => argv.includes("vitest") && hasFlag(argv, "--reporter", "json"),
  },
  {
    parserId: "rspec-json",
    detect: (argv) => argv.includes("rspec") && hasFlag(argv, "--format", "json"),
  },
  {
    parserId: "junit-xml",
    detect: (argv) =>
      argv.some((a) => a.startsWith("--junitxml") || a.startsWith("--junit-xml") || a === "--format=junit"),
  },
  {
    parserId: "cargo-build",
    detect: (argv) => argv.includes("cargo") && argv.includes("build") && hasFlag(argv, "--message-format", "json"),
  },
  {
    parserId: "cargo-test",
    detect: (argv) => argv.includes("cargo") && argv.includes("test"),
  },
  {
    parserId: "dbt-json",
    detect: (argv) =>
      argv.includes("dbt") &&
      (argv.includes("run") || argv.includes("test") || argv.includes("compile")) &&
      hasFlag(argv, "--log-format", "json"),
  },
  {
    parserId: "mypy-json",
    detect: (argv) => argv.includes("mypy") && hasFlag(argv, "--output", "json"),
  },
  {
    parserId: "tsc-text",
    detect: (argv) => argv.includes("tsc") && hasFlag(argv, "--pretty", "false"),
  },
  {
    parserId: "pylint-json",
    detect: (argv) => argv.includes("pylint") && hasFlag(argv, "--output-format", "json"),
  },
  {
    parserId: "shellcheck-json",
    detect: (argv) => argv.includes("shellcheck") && hasFlag(argv, "--format", "json"),
  },
  {
    parserId: "rubocop-json",
    detect: (argv) => argv.includes("rubocop") && hasFlag(argv, "--format", "json"),
  },
  {
    parserId: "swiftc-text",
    detect: (argv) => argv.includes("swiftc") && argv.includes("-typecheck"),
  },
  {
    parserId: "hadolint-json",
    detect: (argv) => argv.includes("hadolint") && hasFlag(argv, "--format", "json"),
  },
  {
    parserId: "stylelint-json",
    detect: (argv) => argv.includes("stylelint") && hasFlag(argv, "--formatter", "json"),
  },
  {
    parserId: "mocha-json",
    detect: (argv) => argv.includes("mocha") && hasFlag(argv, "--reporter", "json"),
  },
  {
    parserId: "unittest-text",
    detect: (argv) =>
      argv.includes("unittest") || (argv.includes("python3") && argv.includes("-m") && argv.includes("unittest")),
  },
  {
    parserId: "go-test-json",
    detect: (argv) => argv.includes("go") && argv.includes("test") && argv.includes("-json"),
  },
  {
    parserId: "ava-text",
    detect: (argv) => argv.includes("ava"),
  },
  {
    parserId: "pyright-json",
    detect: (argv) => argv.includes("pyright") && argv.includes("--outputjson"),
  },
  {
    parserId: "bandit-json",
    detect: (argv) => argv.includes("bandit") && hasFlag(argv, "-f", "json"),
  },
  {
    parserId: "javac-text",
    detect: (argv) => argv.includes("javac") && !argv.includes("-version"),
  },
  {
    parserId: "dotnet-build-text",
    detect: (argv) => argv.includes("dotnet") && argv.includes("build"),
  },
  {
    parserId: "node-test-text",
    detect: (argv) => argv.includes("node") && argv.includes("--test"),
  },
  {
    parserId: "black-text",
    detect: (argv) => argv.includes("black") && argv.includes("--check"),
  },
  {
    parserId: "markdownlint-json",
    detect: (argv) => argv.includes("markdownlint") && argv.includes("--json"),
  },
  {
    parserId: "prettier-text",
    detect: (argv) => argv.includes("prettier") && argv.includes("--check"),
  },
  {
    parserId: "tidy-text",
    detect: (argv) => argv.includes("tidy"),
  },
  {
    parserId: "jsonlint-text",
    detect: (argv) => argv.includes("jsonlint"),
  },
  {
    parserId: "htmlhint-json",
    detect: (argv) => argv.includes("htmlhint") && hasFlag(argv, "--format", "json"),
  },
  {
    parserId: "isort-text",
    detect: (argv) => argv.includes("isort") && argv.includes("--check"),
  },
  {
    parserId: "npm-audit-json",
    detect: (argv) => argv.includes("npm") && argv.includes("audit") && argv.includes("--json"),
  },
  {
    parserId: "vale-json",
    detect: (argv) => argv.includes("vale") && hasFlag(argv, "--output", "JSON"),
  },
  {
    parserId: "clang-text",
    detect: (argv) =>
      (argv.includes("gcc") || argv.includes("g++") || argv.includes("clang") || argv.includes("clang++")) &&
      (argv.includes("-c") || argv.includes("-o")),
  },
];

export function listParsers(): { id: string; autoDetect: boolean }[] {
  const builtInIds = Object.keys(builtIns).filter((id) => id !== "tail-fallback");
  const autoDetectIds = new Set(AUTO_DETECT.map((d) => d.parserId));
  return builtInIds.map((id) => ({ id, autoDetect: autoDetectIds.has(id) }));
}

export async function resolveParser(opts: {
  cwd: string;
  parseAs?: string;
  argv: string[];
  registrations: ParserRegistration[];
}): Promise<ParserModule> {
  if (opts.parseAs && builtIns[opts.parseAs]) return builtIns[opts.parseAs];

  const matched = opts.registrations.find((reg) => matches(reg, opts.argv));
  if (matched?.parseAs && builtIns[matched.parseAs]) return builtIns[matched.parseAs];
  if (matched?.module) {
    const modulePath = path.resolve(opts.cwd, ".pi", matched.module);
    const loaded = await import(modulePath);
    return loaded.default ?? loaded;
  }

  const autoMatched = AUTO_DETECT.find((d) => d.detect(opts.argv));
  if (autoMatched) return builtIns[autoMatched.parserId];

  return builtIns["tail-fallback"];
}

function matches(reg: ParserRegistration, argv: string[]): boolean {
  if (reg.match?.argvIncludes?.length) {
    const ok = reg.match.argvIncludes.every((token) => argv.includes(token));
    if (!ok) return false;
  }
  if (reg.match?.regex) {
    const text = argv.join(" ");
    if (!new RegExp(reg.match.regex).test(text)) return false;
  }
  return Boolean(reg.match?.argvIncludes?.length || reg.match?.regex);
}
