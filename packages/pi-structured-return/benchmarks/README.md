# Benchmarks

Each benchmark runs the same scenario two ways — raw tool output (what the `bash` tool returns to the model) vs structured output (what `structured_return` returns). The numbers in the main README token reduction table come from these files.

## Replicating the results

Token counts use `cl100k_base` via [tiktoken](https://github.com/openai/tiktoken). Install it before running:

```bash
pip install tiktoken
```

Open a pi session in this directory and send the following prompt:

> Read benchmarks/README.md. For each tool listed, run both the raw command using the bash tool and the structured version using structured_return. For each pair, count the tokens in what was returned to you as the tool result using cl100k_base (tiktoken). Then produce a markdown table with columns: Parser, Raw (tokens), Structured (tokens), Reduction (%). One row per tool.

## Test runners

All test runner benchmarks use the same three-test scenario: one passing test, one assertion failure (wrong expected value), one unexpected error/exception.

### pytest

```bash
# raw
pytest test-runners/pytest/test_math.py

# structured
structured_return({ command: "pytest test-runners/pytest/test_math.py --junitxml=.tmp/report.xml", parseAs: "junit-xml", artifactPaths: [".tmp/report.xml"] })
```

### vitest

```bash
# raw
npx vitest run test-runners/vitest/math.test.ts

# structured
structured_return({ command: "npx vitest run test-runners/vitest/math.test.ts --reporter=json", parseAs: "vitest-json" })
```

Note: vitest's raw output includes ANSI color codes. Count tokens on the raw output as-is — the model receives the escape sequences.

### rspec

Setup (run once from `test-runners/rspec/`):

```bash
cd test-runners/rspec && bundle init && bundle add rspec
```

Run both commands from `test-runners/rspec/`:

```bash
# raw
bundle exec rspec math_spec.rb

# structured
structured_return({ command: "bundle exec rspec math_spec.rb --format json", parseAs: "rspec-json" })
```

### minitest

```bash
# raw
ruby test-runners/minitest/math_test.rb

# structured
structured_return({ command: "ruby test-runners/minitest/math_test.rb", parseAs: "minitest-text" })
```

### go / junit-xml

Setup (install `go-junit-report` once):

```bash
go install github.com/jstemmer/go-junit-report/v2@latest
```

Run both commands from `test-runners/go/`:

```bash
# raw
go test

# structured
structured_return({ command: "go test -v 2>&1 | go-junit-report > .tmp/go-report.xml", parseAs: "junit-xml", artifactPaths: [".tmp/go-report.xml"] })
```

### gradle / junit-xml

Setup (run once from `test-runners/java/`):

```bash
cd test-runners/java && gradle test
```

Run both commands from `test-runners/java/`:

```bash
# raw
gradle test

# structured
structured_return({ command: "gradle test", parseAs: "junit-xml", artifactPaths: ["build/test-results/test/TEST-MathTest.xml"] })
```

### dotnet / junit-xml

Setup (run once from `test-runners/dotnet/` to restore packages):

```bash
cd test-runners/dotnet && dotnet restore
```

Requires `JunitXml.TestLogger` — already added to the project. Run both commands from `test-runners/dotnet/`:

```bash
# raw
dotnet test

# structured
structured_return({ command: "dotnet test --logger \"junit;LogFilePath=.tmp/report.xml\"", parseAs: "junit-xml", artifactPaths: [".tmp/report.xml"] })
```

### phpunit / junit-xml

Setup (run once from `test-runners/phpunit/`):

```bash
cd test-runners/phpunit && composer install
```

Run both commands from `test-runners/phpunit/`:

```bash
# raw
./vendor/bin/phpunit

# structured
structured_return({ command: "./vendor/bin/phpunit --log-junit .tmp/report.xml", parseAs: "junit-xml", artifactPaths: [".tmp/report.xml"] })
```

### pest / junit-xml

Setup (run once from `test-runners/pest/`):

```bash
cd test-runners/pest && composer install
```

Run both commands from `test-runners/pest/`:

```bash
# raw
./vendor/bin/pest tests/MathTest.php

# structured
structured_return({ command: "./vendor/bin/pest tests/MathTest.php --log-junit=.tmp/report.xml", parseAs: "junit-xml", artifactPaths: [".tmp/report.xml"] })
```

### maven / junit-xml

Setup (run once from `test-runners/maven/` to pull dependencies):

```bash
cd test-runners/maven && mvn test
```

Run both commands from `test-runners/maven/`:

```bash
# raw
mvn test

# structured
structured_return({ command: "mvn test", parseAs: "junit-xml", artifactPaths: ["target/surefire-reports/TEST-MathTest.xml"] })
```

### jest / junit-xml

Setup (run once from `test-runners/jest/`):

```bash
cd test-runners/jest && npm install
```

Run both commands from `test-runners/jest/`:

```bash
# raw
npx jest

# structured
structured_return({ command: "JEST_JUNIT_OUTPUT_FILE=.tmp/junit.xml npx jest --reporters=jest-junit", parseAs: "junit-xml", artifactPaths: [".tmp/junit.xml"] })
```

### playwright / junit-xml

Setup (run once from `test-runners/playwright/`):

```bash
cd test-runners/playwright && npm install
```

Run both commands from `test-runners/playwright/`:

```bash
# raw
npx playwright test math.test.ts

# structured
structured_return({ command: "PLAYWRIGHT_JUNIT_OUTPUT_FILE=.tmp/report.xml npx playwright test math.test.ts --reporter=junit", parseAs: "junit-xml", artifactPaths: [".tmp/report.xml"] })
```

Note: Uses pure `@playwright/test` assertions without browser/page — no browser download needed.

### cargo test

```bash
# raw
cargo test

# structured
structured_return({ command: "cargo test", parseAs: "cargo-test" })
```

### cargo build

```bash
# raw
cargo build

# structured
structured_return({ command: "cargo build --message-format=json", parseAs: "cargo-build" })
```

Run both commands from `test-runners/cargo/` (cargo test) and `test-runners/cargo-build/` (cargo build).

### go test (native JSON)

No extra dependencies — uses Go's built-in `-json` flag. Run from `test-runners/go-json/`:

```bash
# raw (default text output — what bash returns)
go test ./...

# structured
structured_return({ command: "go test -json ./...", parseAs: "go-test-json" })
```

### mocha

Setup (run once from `test-runners/mocha/`):

```bash
cd test-runners/mocha && npm install
```

Run both commands from `test-runners/mocha/`:

```bash
# raw
npx mocha test_math.js

# structured
structured_return({ command: "npx mocha test_math.js --reporter json", parseAs: "mocha-json" })
```

### ava

Setup (run once from `test-runners/ava/`):

```bash
cd test-runners/ava && npm install
```

Run both commands from `test-runners/ava/`:

```bash
# raw
npx ava test_math.js

# structured
structured_return({ command: "npx ava test_math.js --no-color", parseAs: "ava-text" })
```

### node --test (native)

```bash
# raw
node --test test-runners/node-test/test_math.mjs

# structured
structured_return({ command: "node --test test-runners/node-test/test_math.mjs", parseAs: "node-test-text" })
```

### unittest

```bash
# raw
python3 -m unittest test-runners/unittest/test_math.py

# structured
structured_return({ command: "python3 -m unittest test-runners/unittest/test_math.py", parseAs: "unittest-text" })
```

## Linters

Linter benchmarks use a single file with one or two violations — a conservative lower bound. Reduction grows as violations spread across more files.

### ruff

```bash
# raw
ruff check linters/lint_check.py --select F841

# structured
structured_return({ command: "ruff check linters/lint_check.py --select F841 --output-format=json", parseAs: "ruff-json" })
```

### eslint

```bash
# raw
npx eslint --config linters/eslint.config.mjs linters/lint_check.ts

# structured
structured_return({ command: "npx eslint --config linters/eslint.config.mjs linters/lint_check.ts -f json", parseAs: "eslint-json" })
```

### mypy

```bash
# raw
mypy linters/mypy/type_check.py

# structured
structured_return({ command: "mypy --output json linters/mypy/type_check.py", parseAs: "mypy-json" })
```

### tsc

```bash
# raw
tsc --noEmit linters/tsc/type_check.ts

# structured
structured_return({ command: "tsc --noEmit --pretty false linters/tsc/type_check.ts", parseAs: "tsc-text" })
```

### pylint

```bash
# raw
pylint linters/pylint/lint_check.py

# structured
structured_return({ command: "pylint --output-format=json linters/pylint/lint_check.py", parseAs: "pylint-json" })
```

### shellcheck

```bash
# raw
shellcheck linters/shellcheck/lint_check.sh

# structured
structured_return({ command: "shellcheck --format=json linters/shellcheck/lint_check.sh", parseAs: "shellcheck-json" })
```

### rubocop

Setup (install once):

```bash
gem install rubocop
```

```bash
# raw
rubocop linters/rubocop/lint_check.rb

# structured
structured_return({ command: "rubocop --format json linters/rubocop/lint_check.rb", parseAs: "rubocop-json" })
```

### hadolint

```bash
# raw
hadolint linters/hadolint/Dockerfile

# structured
structured_return({ command: "hadolint --format json linters/hadolint/Dockerfile", parseAs: "hadolint-json" })
```

### stylelint

Setup (install once):

```bash
npm install -g stylelint stylelint-config-standard
```

```bash
# raw
stylelint linters/stylelint/lint_check.css

# structured
structured_return({ command: "stylelint --formatter json linters/stylelint/lint_check.css", parseAs: "stylelint-json" })
```

### gcc / clang

```bash
# raw
gcc -c linters/clang/type_check.c -o /dev/null

# structured
structured_return({ command: "gcc -c linters/clang/type_check.c -o /dev/null", parseAs: "clang-text" })
```

### dotnet build

Run from `linters/dotnet-build/`:

```bash
# raw
dotnet build

# structured
structured_return({ command: "dotnet build", parseAs: "dotnet-build-text" })
```

### javac

```bash
# raw
javac linters/javac/TypeCheck.java

# structured
structured_return({ command: "javac linters/javac/TypeCheck.java", parseAs: "javac-text" })
```

### htmlhint

```bash
# raw
npx htmlhint linters/htmlhint/check.html

# structured
structured_return({ command: "npx htmlhint --format json linters/htmlhint/check.html", parseAs: "htmlhint-json" })
```

### isort

```bash
# raw
isort --check --diff linters/isort/import_check.py

# structured
structured_return({ command: "isort --check --diff linters/isort/import_check.py", parseAs: "isort-text" })
```

### npm audit

Setup (run once from `linters/npm-audit/`):

```bash
cd linters/npm-audit && npm install
```

```bash
# raw
npm audit

# structured
structured_return({ command: "npm audit --json", parseAs: "npm-audit-json" })
```

### jsonlint

```bash
# raw
npx jsonlint linters/jsonlint/check.json

# structured
structured_return({ command: "npx jsonlint linters/jsonlint/check.json", parseAs: "jsonlint-text" })
```

### tidy

```bash
# raw
tidy -errors linters/tidy/check.html

# structured
structured_return({ command: "tidy -errors linters/tidy/check.html", parseAs: "tidy-text" })
```

### vale

Setup (install once, create `.vale.ini` config):

```bash
brew install vale
```

```bash
# raw
vale linters/vale/prose_check.md

# structured
structured_return({ command: "vale --output JSON linters/vale/prose_check.md", parseAs: "vale-json" })
```

### prettier

```bash
# raw
prettier --check linters/prettier/format_check.ts

# structured
structured_return({ command: "prettier --check linters/prettier/format_check.ts", parseAs: "prettier-text" })
```

### markdownlint

```bash
# raw
markdownlint linters/markdownlint/lint_check.md

# structured
structured_return({ command: "markdownlint --json linters/markdownlint/lint_check.md", parseAs: "markdownlint-json" })
```

### black

```bash
# raw
black --check --diff linters/black/format_check.py

# structured
structured_return({ command: "black --check linters/black/format_check.py", parseAs: "black-text" })
```

### bandit

```bash
# raw
bandit linters/bandit/security_check.py

# structured
structured_return({ command: "bandit -f json linters/bandit/security_check.py", parseAs: "bandit-json" })
```

### pyright

```bash
# raw
pyright linters/pyright/type_check.py

# structured
structured_return({ command: "pyright --outputjson linters/pyright/type_check.py", parseAs: "pyright-json" })
```

### swiftc

```bash
# raw
swiftc -typecheck linters/swiftc/type_check.swift

# structured
structured_return({ command: "swiftc -typecheck linters/swiftc/type_check.swift", parseAs: "swiftc-text" })
```

## Pipeline tools

No live dbt project needed — benchmarks use saved plain text (raw) and JSONL (structured) sample output in `pipeline-tools/dbt/`.

### dbt run

```bash
# raw (plain text samples)
cat pipeline-tools/dbt/dbt-run-success.log          # 3-model success
cat pipeline-tools/dbt/dbt-run-failure.log           # 2 errors, 1 skip

# structured (JSONL fed to parser)
structured_return({ command: "dbt run --log-format json", parseAs: "dbt-json" })
```

### dbt test

```bash
# raw
cat pipeline-tools/dbt/dbt-test-failure.log          # 2 fail, 1 unit test diff

# structured
structured_return({ command: "dbt test --log-format json", parseAs: "dbt-json" })
```

### dbt compile

```bash
# raw
cat pipeline-tools/dbt/dbt-compile.log               # 3 models compiled to SQL

# structured
structured_return({ command: "dbt compile -s model_name --log-format json", parseAs: "dbt-json" })
```
