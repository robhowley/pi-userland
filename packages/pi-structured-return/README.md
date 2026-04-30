# pi-structured-return

A [Pi](https://pi.dev/) extension that adds a `structured_return` tool alongside `bash`, returning compact parsed results with full logs — 60–95% fewer tokens without losing signal.

A failing test run, before and after:

**Raw pytest output (262 tokens):**

```
============================= test session starts ==============================
platform darwin -- Python 3.14.2, pytest-9.0.2
collecting ... collected 3 items

test_math.py::test_adds_two_numbers_correctly PASSED                     [ 33%]
test_math.py::test_multiplies_two_numbers_correctly FAILED               [ 66%]
test_math.py::test_does_not_divide_by_zero FAILED                        [100%]

=================================== FAILURES ===================================
____________________ test_multiplies_two_numbers_correctly _____________________

    def test_multiplies_two_numbers_correctly():
>       assert 3 * 4 == 99
E       assert (3 * 4) == 99

test_math.py:5: AssertionError
_________________________ test_does_not_divide_by_zero _________________________

    def test_does_not_divide_by_zero():
>       result = 1 / 0
                 ^^^^^
E       ZeroDivisionError: division by zero

test_math.py:8: ZeroDivisionError
=========================== short test summary info ============================
FAILED test_math.py::test_multiplies_two_numbers_correctly
FAILED test_math.py::test_does_not_divide_by_zero - ZeroDivisionError: ...
========================= 2 failed, 1 passed in 0.01s ==========================
```

**Structured result returned to the model (56 tokens):**

```
pytest test_math.py --junitxml=.tmp/report.xml → cwd: project
2 failed, 1 passed
  test_math.py:5  assert (3 * 4) == 99
  test_math.py:8  ZeroDivisionError: division by zero
```

262 → 56 tokens on a 3-test example. Real test suites are much larger — the reduction scales with them, saving thousands of tokens per run.

## Installation

```bash
pi install npm:@robhowley/pi-structured-return
```

## Design

`structured_return` is a separate tool, not a wrapper around `bash`. Intercepting `bash` to silently rewrite commands would override a primitive the model and platform both rely on. Pi's philosophy is to extend rather than obfuscate: features are built on top of the platform, not hidden inside it. A dedicated tool honors that. It adds to the available surface, keeps `bash` honest, and leaves the choice explicit. The skill guides the model toward it; nothing is hijacked to get there.

## Token reduction

Measured with `cl100k_base` (tiktoken). All benchmarks use tiny fixtures — reduction grows with real-world output.

### Test runners

Benchmark: 3 tests — 1 passing, 1 assertion failure, 1 unexpected error.

| Tool                  | Raw  | Structured | Reduction | Notes                                                                                                            |
| --------------------- | ---- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `mvn test`            | 1063 | 86         | **92%**   | build lifecycle noise with surefire stack traces per failure                                                     |
| `node --test`         | 629  | 64         | **90%**   | strips full stack traces, assertion internals, timing; preserves expected/actual                                 |
| `npx ava`             | 483  | 56         | **88%**   | source snippets, diffs, full stack traces stripped; expected/actual preserved                                    |
| `go test`             | 394  | 48         | **88%**   | stack traces, goroutine frames, panic recovery noise stripped; file:line + expected/actual preserved             |
| `npx playwright test` | 542  | 91         | **83%**   | ANSI output, attachment paths, source snippets, and stack traces stripped; file:line + expected/actual preserved |
| `pest`                | 382  | 81         | **79%**   | source snippets, test-name prefixes, and repeated file refs stripped; file:line preserved                        |
| `dotnet test`         | 487  | 107        | **78%**   | build header and VSTest output with per-failure stack traces                                                     |
| `npx vitest`          | 348  | 75         | **78%**   | source diff with inline arrows and ANSI color codes per failure                                                  |
| `python -m unittest`  | 231  | 52         | **78%**   | full tracebacks with source annotations; expected/actual from AssertionError                                     |
| `cargo test`          | 285  | 68         | **76%**   | cargo progress + test binary output with panic traces per failure                                                |
| `pytest`              | 289  | 71         | **75%**   | verbose output with source snippets and summary footer                                                           |
| `phpunit`             | 288  | 75         | **74%**   | method headers and absolute paths stripped; body file:line preferred over tc.line                                |
| `rspec`               | 212  | 55         | **74%**   | default output with backtrace                                                                                    |
| `gradle test`         | 263  | 81         | **69%**   | gradle console output with build lifecycle noise                                                                 |
| `npx mocha`           | 180  | 55         | **69%**   | stack traces + assertion diff formatting; expected/actual preserved                                              |
| `npx jest`            | 309  | 99         | **68%**   | source annotations with deep jest-circus stack traces per failure                                                |
| `ruby` (minitest)     | 168  | 59         | **65%**   | default output with backtrace                                                                                    |

### Build tools and compilers

Benchmark: 1 file, 1–2 errors. Reduction scales with error count since raw output includes source snippets, caret indicators, and annotations per error.

| Tool            | Raw | Structured | Reduction | Notes                                                                                      |
| --------------- | --- | ---------- | --------- | ------------------------------------------------------------------------------------------ |
| `dotnet build`  | 383 | 53         | **86%**   | strips restore/timing noise, deduplicates repeated error lines, absolute paths relativized |
| `npx jsonlint`  | 148 | 28         | **81%**   | strips stack trace, source pointer line; preserves line number and expecting message       |
| `tidy`          | 233 | 51         | **78%**   | strips remediation advice, accessibility tips, reformatted HTML output, Info lines         |
| `cargo build`   | 225 | 77         | **66%**   | rustc error annotations with code spans and help text per error                            |
| `swiftc`        | 161 | 58         | **64%**   | source annotations with backtick markers deduplicated                                      |
| `gcc` / `clang` | 109 | 77         | **29%**   | strips source snippets, caret indicators, line numbers from gutter                         |
| `javac`         | 79  | 66         | **16%**   | strips source snippets, caret indicators; folds symbol/location into message               |

### Linters and type checkers

Benchmark: 1 file, 1–2 violations. Reduction is a conservative lower bound — scales with file and error count since raw output repeats paths, source snippets, and annotations per violation.

| Tool               | Raw | Structured | Reduction | Notes                                                                            |
| ------------------ | --- | ---------- | --------- | -------------------------------------------------------------------------------- |
| `isort --check`    | 143 | 29         | **80%**   | strips diff hunks, absolute paths, timestamps; lists files with unsorted imports |
| `black --check`    | 155 | 31         | **80%**   | strips diff hunks, emoji, timestamps; lists files needing reformatting           |
| `ruff check`       | 107 | 52         | **51%**   | source context + help text per error                                             |
| `shellcheck`       | 224 | 117        | **48%**   | strips source snippets, carets, suggestions, wiki URLs                           |
| `npx htmlhint`     | 174 | 92         | **47%**   | strips ANSI codes, source evidence, rule descriptions, URLs                      |
| `vale`             | 141 | 79         | **44%**   | strips ANSI codes, Action/Span metadata, column-aligned formatting               |
| `markdownlint`     | 199 | 117        | **41%**   | strips context quotes, URLs, fix info, error ranges                              |
| `pyright`          | 100 | 59         | **41%**   | strips version, timing, absolute paths; detail lines collapsed                   |
| `rubocop`          | 149 | 90         | **40%**   | strips source snippets, caret indicators, summary line                           |
| `tsc`              | 107 | 72         | **33%**   | vs `--pretty true` default; source snippets and underlines stripped              |
| `stylelint`        | 70  | 51         | **27%**   | strips summary footer and fix hint                                               |
| `pylint`           | 141 | 120        | **15%**   | strips header, score line, separator; scales with error count                    |
| `prettier --check` | 38  | 33         | **13%**   | strips preamble, [warn] prefixes, footer hint; scales with file count            |
| `hadolint`         | 178 | 156        | **12%**   | strips ANSI color codes and level labels; measured vs colored output             |
| `eslint`           | 64  | 59         | **8%**    | already compact formatter                                                        |
| `mypy`             | 75  | 72         | **4%**    | mypy text is already compact; notes folded into parent errors                    |

### Security and audit

| Tool        | Raw | Structured | Reduction | Notes                                                                                    |
| ----------- | --- | ---------- | --------- | ---------------------------------------------------------------------------------------- |
| `bandit`    | 402 | 99         | **75%**   | strips source snippets, CWE URLs, run metrics, confidence labels                         |
| `npm audit` | 158 | 50         | **68%**   | strips advisory URLs, fix instructions, CVSS vectors; advisory titles joined per package |

### Pipeline tools

dbt output is the noisiest tool in this repo relative to useful signal. Every run prints version info, adapter registration, project stats, concurrency settings, and per-node start/finish lines — all before any result.

The numbers below use 3–4 model toy examples; real projects run hundreds of models where the noise scales linearly and reduction compounds.

| Tool                | Raw | Structured | Reduction | Notes                                                                        |
| ------------------- | --- | ---------- | --------- | ---------------------------------------------------------------------------- |
| `dbt run` (success) | 428 | 20         | **95%**   | version, adapter, concurrency, per-model start/finish — all noise on success |
| `dbt run` (failure) | 618 | 198        | **68%**   | error messages, model paths, compiled code paths preserved                   |
| `dbt test`          | 720 | 274        | **62%**   | unit test diff tables preserved verbatim; preamble stripped                  |
| `dbt compile`       | 775 | 683        | **12%**   | compiled SQL is the signal and returned verbatim                             |

At 12 models, run failures hit 85% reduction. An 18-model DAG success: 1,645 → 20 tokens (99%).

### Already compact — use `bash` directly

Evaluated for structured parsing but raw output is already compact enough that a parser adds no reduction (or goes negative). Use `bash` instead of `structured_return` for these tools.

| Tool            | Raw tokens | Format                               | Why no parser                                                    |
| --------------- | ---------- | ------------------------------------ | ---------------------------------------------------------------- |
| `go build`      | 85         | `file:line:col: message`             | one line per error, no decoration                                |
| `flake8`        | 75         | `file:line:col: CODE message`        | no JSON without a plugin; text is already one line per violation |
| `yamllint`      | 72         | `file:line:col level message (rule)` | filename printed once; one line per issue                        |
| `golangci-lint` | 59         | `file:line:col: message (linter)`    | text output already minimal; JSON includes massive linter report |
| `go vet`        | ~60        | `file:line:col: message`             | same format as `go build`                                        |
| `vulture`       | 58         | `file:line: message (confidence%)`   | single line per finding                                          |
| `pydocstyle`    | 48         | `file:line context + CODE: message`  | two lines per issue; structured format would repeat file paths   |

## How it works

1. The agent runs commands through `structured_return` when it would reduce noise and token usage.
2. Full output is captured and stored as a log.
3. A parser converts noisy CLI output into a compact structured result. If no parser matches, the last 200 lines and the log path are returned as a fallback.
4. The agent receives the structured result in context — signal only, no noise.
5. The full log is always available on disk for both the agent and humans to inspect.
6. Run `/sr-stats` to see how many tokens structured-return has saved — for the current session, the current working directory, and lifetime across all sessions.

Run `/sr-parsers` in a pi session to see all registered parsers with their match rules. Run `/sr-stats` to see token savings for the current session, cwd lifetime, and lifetime.

## Extending with project-local parsers

Built-in parsers cover common tools. For everything else — internal CLIs, custom test runners, proprietary lint tools — add a `.pi/structured-return.json` to your project root.

**Why:** keeps token costs low for tools the built-ins don't know about, without forking the package.

**Two options:**

### 1. Re-use a built-in parser

Route a project-specific command to an existing parser. Use this when your tool's output already matches a supported format (e.g. a test runner that emits JUnit XML).

```json
// .pi/structured-return.json
{
  "parsers": [
    {
      "id": "acme-tests",
      "match": { "argvIncludes": ["acme", "test"] },
      "parseAs": "junit-xml"
    }
  ]
}
```

### 2. Write a custom parser

Point to a local `.ts` file for tools with unique output formats.

```json
// .pi/structured-return.json
{
  "parsers": [
    {
      "id": "foo-json",
      "match": { "argvIncludes": ["foo-cli", "check"] },
      "module": "parsers/foo-cli.js"
    }
  ]
}
```

```ts
// .pi/parsers/foo-cli.ts
import fs from "node:fs";
import type { RunContext } from "@robhowley/pi-structured-return/types";

export default {
  id: "foo-json",
  async parse(ctx: RunContext) {
    const data = JSON.parse(fs.readFileSync(ctx.stdoutPath, "utf8"));
    return {
      tool: "foo-cli",
      status: data.ok ? "pass" : "fail",
      summary: data.ok ? "passed" : `${data.errors.length} errors`,
      failures: data.errors.map((e, i) => ({
        id: e.id ?? `error-${i}`,
        file: e.file,
        line: e.line,
        message: e.message,
      })),
      logPath: ctx.logPath,
    };
  },
};
```

The parser receives a `RunContext` (command, argv, cwd, stdout/stderr paths, artifact paths, log path) and returns a `ParsedResult`. Match rules support `argvIncludes` (array of required tokens) or `regex` (tested against the full argv string).

## Structured result schema

Every parser returns the same shape. The model always knows where to look.

| Field      | Type                                      | Description                                                         |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `tool`     | `string`                                  | Name of the tool that ran (`eslint`, `pytest`, etc.)                |
| `exitCode` | `number`                                  | Raw process exit code                                               |
| `status`   | `pass \| fail \| error`                   | Normalized outcome                                                  |
| `summary`  | `string`                                  | One-line human+model readable result (`3 failed, 12 passed`)        |
| `cwd`      | `string`                                  | Working directory — anchor for resolving relative paths in failures |
| `failures` | `{ id, file?, line?, message?, rule? }[]` | Per-failure details with relative file paths                        |
| `logPath`  | `string`                                  | Path to full stdout+stderr log                                      |
| `rawTail`  | `string?`                                 | Last 200 lines of log, included on fallback when no parser matched  |
