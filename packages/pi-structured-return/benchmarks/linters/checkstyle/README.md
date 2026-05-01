# Checkstyle Benchmark Fixture

Checkstyle XML parser benchmark demonstrating token savings.

## Structure

- `fixture/` — Minimal Checkstyle project with intentional violations
  - `checkstyle.xml` — Config with LineLength, LeftCurly, NeedBraces rules
  - `src/SampleViolations.java` — Java file with 4 intentional violations
- `raw-output.xml` — Captured raw Checkstyle XML output
- `benchmark.mjs` — Token counting and comparison script
- `results.json` — Generated benchmark results

## Running

```bash
node benchmark.mjs
```

## Expected Violations

1. **LineLength** (line 4): Comment exceeds 80 chars
2. **LeftCurly** (line 7): Brace on wrong line
3. **NeedBraces** (line 9): If statement without braces
4. **LineLength** (line 14): String literal exceeds 80 chars

## Command Used

```bash
java -jar checkstyle-10.23.1-all.jar -c fixture/checkstyle.xml -f xml fixture/src
```

## Integration with Main Benchmark Suite

This fixture can be run standalone or via the main benchmark runner:

```bash
cd benchmarks
node linters/checkstyle/benchmark.mjs
```

## Notes

- Uses a simple token counting approximation (splits on whitespace/punctuation)
- For production benchmarks, use `python3 -m tiktoken` with `cl100k_base` encoding
- Token savings improve significantly with more files and violations
