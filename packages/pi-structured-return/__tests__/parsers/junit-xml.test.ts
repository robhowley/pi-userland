import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import parser from "../../extensions/structured-return/parsers/junit-xml";
import type { RunContext } from "../../extensions/structured-return/types";

function makeCtx(xml: string, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junit-test-"));
  const artifactPath = path.join(dir, "report.xml");
  fs.writeFileSync(artifactPath, xml);
  return {
    command: "gradle test",
    argv: ["gradle", "test"],
    cwd,
    artifactPaths: [artifactPath],
    stdoutPath: path.join(dir, "stdout"),
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

function makeMultiCtx(xmlFiles: Record<string, string>, cwd = "/project"): RunContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junit-multi-"));
  const artifactPaths: string[] = [];
  for (const [name, xml] of Object.entries(xmlFiles)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, xml);
    artifactPaths.push(p);
  }
  return {
    command: "gradle test",
    argv: ["gradle", "test"],
    cwd,
    artifactPaths,
    stdoutPath: path.join(dir, "stdout"),
    stderrPath: path.join(dir, "stderr"),
    logPath: path.join(dir, "log"),
  };
}

const PASSING = (name: string, classname = "com.example.MyTest") =>
  `<testcase name="${name}" classname="${classname}" time="0.001"/>`;

const FAILING = (
  name: string,
  classname: string,
  message: string,
  type = "AssertionError",
  file?: string,
  line?: number
) => {
  const fileAttr = file ? ` file="${file}"` : "";
  const lineAttr = line !== undefined ? ` line="${line}"` : "";
  return `<testcase name="${name}" classname="${classname}"${fileAttr}${lineAttr} time="0.001">
    <failure message="${message}" type="${type}">full details here</failure>
  </testcase>`;
};

const ERROR = (name: string, classname: string, message: string, type = "RuntimeError") =>
  `<testcase name="${name}" classname="${classname}" time="0.001">
    <error message="${message}" type="${type}">stack trace</error>
  </testcase>`;

describe("junit-xml parser", () => {
  describe("testsuites wrapper (multi-suite)", () => {
    it("mix of passed and failed → status fail, correct counts", async () => {
      const xml = `<?xml version="1.0"?>
        <testsuites>
          <testsuite name="suite1" tests="2" failures="1" errors="0">
            ${PASSING("test_a")}
            ${FAILING("test_b", "com.example.MyTest", "expected 2 but was 1")}
          </testsuite>
          <testsuite name="suite2" tests="2" failures="0" errors="0">
            ${PASSING("test_c")}
            ${PASSING("test_d")}
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 3 passed");
      expect(result.failures).toHaveLength(1);
    });

    it("all passing → status pass", async () => {
      const xml = `<testsuites>
        <testsuite name="suite" tests="2" failures="0" errors="0">
          ${PASSING("test_a")}
          ${PASSING("test_b")}
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.status).toBe("pass");
      expect(result.summary).toBe("2 passed");
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("bare testsuite (no wrapper)", () => {
    it("single testsuite at root → parsed correctly", async () => {
      const xml = `<testsuite name="suite" tests="2" failures="1" errors="0">
        ${PASSING("test_a")}
        ${FAILING("test_b", "com.example.MyTest", "assert failed")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 1 passed");
    });
  });

  describe("error elements", () => {
    it("error counts as failure, message surfaced", async () => {
      const xml = `<testsuite name="suite" tests="2" failures="0" errors="1">
        ${PASSING("test_a")}
        ${ERROR("test_b", "com.example.MyTest", "NullPointerException", "java.lang.NullPointerException")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 1 passed");
      expect(result.failures![0].message).toBe("NullPointerException");
      expect(result.failures![0].rule).toBe("java.lang.NullPointerException");
    });
  });

  describe("file and line resolution", () => {
    it("file on testcase → relativized to cwd", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="1" errors="0">
        ${FAILING("test_b", "MyTest", "oops", "AssertionError", "/project/src/test/MyTest.java", 42)}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].file).toBe("src/test/MyTest.java");
      expect(result.failures![0].line).toBe(42);
    });

    it("non-php keeps testcase line when the body also has a parseable location", async () => {
      const xml = `<testsuite name="MathTest" tests="1" failures="0" errors="1">
        <testcase name="multipliesTwoNumbersCorrectly" classname="MathTest" file="/project/src/test/MyTest.java" line="42" time="0.001">
          <error message="expected: &lt;99&gt; but was: &lt;12&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <99> but was: <12>
	at MathTest.multipliesTwoNumbersCorrectly(MyTest.java:13)
	at java.base/java.lang.reflect.Method.invoke(Method.java:565)
]]></error>
        </testcase>
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].file).toBe("src/test/MyTest.java");
      expect(result.failures![0].line).toBe(42);
    });

    it("file on testsuite (not testcase) → used as fallback", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="1" errors="0" file="src/spec/foo_spec.rb">
        ${FAILING("test_b", "MyTest", "oops")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].file).toBe("src/spec/foo_spec.rb");
    });

    it("no file attr → classname converted to java path", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="1" errors="0">
        ${FAILING("test_b", "com.example.service.MyTest", "oops")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].file).toBe("com/example/service/MyTest.java");
    });

    it("path-like classname with extension is treated as a file, not a java package", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="1" errors="0">
        ${FAILING("test_b", "math.test.ts", "oops")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].file).toBe("math.test.ts");
    });
  });

  describe("failure message", () => {
    it("message attr surfaced directly", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="1" errors="0">
        ${FAILING("test_b", "MyTest", "expected: 99 but was: 12")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].message).toBe("expected: 99 but was: 12");
    });

    it("failure type surfaced as rule", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="1" errors="0">
        ${FAILING("test_b", "MyTest", "oops", "org.junit.ComparisonFailure")}
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].rule).toBe("org.junit.ComparisonFailure");
    });
  });

  describe("go-junit-report output", () => {
    it("extracts panic message and file:line from system-out when failure body is empty", async () => {
      const xml = `<testsuites tests="2" failures="1">
        <testsuite name="math-benchmark" tests="2" failures="1" errors="0">
          <testcase name="TestAddsTwoNumbersCorrectly" classname="math-benchmark" time="0.000"/>
          <testcase name="TestDoesNotPanic" classname="math-benchmark" time="0.000">
            <failure message="Failed"></failure>
          </testcase>
          <system-out><![CDATA[panic: runtime error: invalid memory address or nil pointer dereference [recovered, repanicked]
goroutine 23 [running]:
math-benchmark.TestDoesNotPanic(0x123)
	/project/math_test.go:22 +0x4
]]></system-out>
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].message).toBe("runtime error: invalid memory address or nil pointer dereference");
      expect(result.failures![0].file).toBe("math_test.go");
      expect(result.failures![0].line).toBe(22);
    });

    it("extracts file, line, and message from Go failure body", async () => {
      const xml = `<testsuites tests="2" failures="1">
        <testsuite name="math-benchmark" tests="2" failures="1" errors="0">
          <testcase name="TestAddsTwoNumbersCorrectly" classname="math-benchmark" time="0.000"/>
          <testcase name="TestMultipliesTwoNumbersCorrectly" classname="math-benchmark" time="0.000">
            <failure message="Failed"><![CDATA[    math_test.go:16: expected 99, got 12]]></failure>
          </testcase>
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].file).toBe("math_test.go");
      expect(result.failures![0].line).toBe(16);
      expect(result.failures![0].message).toBe("expected 99, got 12");
    });
  });

  describe("maven / java stack trace output", () => {
    it("extracts file and line from first frame matching classname", async () => {
      const xml = `<testsuite name="MathTest" tests="1" failures="0" errors="1">
        <testcase name="multipliesTwoNumbersCorrectly" classname="MathTest" time="0.001">
          <error message="expected: &lt;99&gt; but was: &lt;12&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <99> but was: <12>
	at org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
	at org.junit.jupiter.api.AssertEquals.assertEquals(AssertEquals.java:150)
	at MathTest.multipliesTwoNumbersCorrectly(MathTest.java:13)
	at java.base/java.lang.reflect.Method.invoke(Method.java:565)
]]></error>
        </testcase>
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].file).toBe("MathTest.java");
      expect(result.failures![0].line).toBe(13);
    });

    it("falls back to first non-framework frame when classname has no match", async () => {
      const xml = `<testsuite name="suite" tests="1" failures="0" errors="1">
        <testcase name="doesNotDivideByZero" classname="MathTest" time="0.001">
          <error message="/ by zero" type="java.lang.ArithmeticException"><![CDATA[java.lang.ArithmeticException: / by zero
	at MathTest.doesNotDivideByZero(MathTest.java:18)
	at java.base/java.lang.reflect.Method.invoke(Method.java:565)
]]></error>
        </testcase>
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].file).toBe("MathTest.java");
      expect(result.failures![0].line).toBe(18);
    });
  });

  describe("dotnet / xunit output", () => {
    it("extracts file and line from .NET stack trace body", async () => {
      const xml = `<testsuites>
        <testsuite name="dotnet.dll" tests="1" failures="1" errors="0">
          <testcase classname="Benchmark.MathTest" name="DoesNotThrowOnNullAccess" time="0.001">
            <failure type="failure" message="System.NullReferenceException : Object reference not set to an instance of an object.">at Benchmark.MathTest.DoesNotThrowOnNullAccess() in /project/MathTest.cs:line 21
   at System.Reflection.MethodBaseInvoker.InterpretedInvoke_Method(Object obj, IntPtr* args)</failure>
          </testcase>
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].file).toBe("MathTest.cs");
      expect(result.failures![0].line).toBe(21);
    });

    it("decodes &#xA; entities in message attribute", async () => {
      const xml = `<testsuites>
        <testsuite name="dotnet.dll" tests="1" failures="1" errors="0">
          <testcase classname="Benchmark.MathTest" name="MultipliesTwoNumbersCorrectly" time="0.001">
            <failure type="failure" message="Assert.Equal() Failure: Values differ&#xA;Expected: 99&#xA;Actual:   12">at Benchmark.MathTest.MultipliesTwoNumbersCorrectly() in /project/MathTest.cs:line 14</failure>
          </testcase>
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.failures![0].message).toBe("Assert.Equal() Failure: Values differ\nExpected: 99\nActual:   12");
    });
  });

  describe("pytest --junitxml output", () => {
    it("extracts file and line from failure body when no file attr present", async () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
        <testsuites name="pytest tests">
          <testsuite name="pytest" errors="0" failures="1" skipped="0" tests="2">
            <testcase classname="tests.test_math" name="test_adds" time="0.000"/>
            <testcase classname="tests.test_math" name="test_multiplies" time="0.000">
              <failure message="assert (3 * 4) == 99">def test_multiplies():
&gt;       assert 3 * 4 == 99
E       assert (3 * 4) == 99

tests/test_math.py:5: AssertionError</failure>
            </testcase>
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].file).toBe("tests/test_math.py");
      expect(result.failures![0].line).toBe(5);
      expect(result.failures![0].message).toBe("assert (3 * 4) == 99");
    });
  });

  describe("jest-junit output", () => {
    it("extracts file, line, and message from plain-text failure elements", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <testsuites name="jest tests" tests="3" failures="2" errors="0">
          <testsuite name="basic math" errors="0" failures="2" skipped="0" tests="3">
            <testcase classname="basic math adds two numbers correctly" name="basic math adds two numbers correctly" time="0"/>
            <testcase classname="basic math multiplies two numbers correctly" name="basic math multiplies two numbers correctly" time="0.001">
              <failure>Error: expect(received).toBe(expected) // Object.is equality

Expected: 99
Received: 12
    at Object.toBe (/project/math.test.js:7:19)
    at Promise.then.completed (/project/node_modules/jest-circus/build/utils.js:298:28)</failure>
            </testcase>
            <testcase classname="basic math does not divide by zero" name="basic math does not divide by zero" time="0">
              <failure>TypeError: Cannot read properties of null (reading 'value')
    at Object.value (/project/math.test.js:11:25)
    at Promise.then.completed (/project/node_modules/jest-circus/build/utils.js:298:28)</failure>
            </testcase>
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 1 passed");
      expect(result.failures![0].file).toBe("math.test.js");
      expect(result.failures![0].line).toBe(7);
      expect(result.failures![0].message).toBe(
        "Error: expect(received).toBe(expected) // Object.is equality\nExpected: 99\nReceived: 12"
      );
      expect(result.failures![1].file).toBe("math.test.js");
      expect(result.failures![1].line).toBe(11);
      expect(result.failures![1].message).toBe("TypeError: Cannot read properties of null (reading 'value')");
    });
  });

  describe("playwright --reporter=junit output", () => {
    it("extracts file, line, and message from failure and error elements", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites id="" name="" tests="3" failures="1" skipped="0" errors="1" time="0.488">
<testsuite name="math.test.ts" tests="3" failures="1" errors="1" skipped="0" time="0.004">
<testcase name="basic math › adds two numbers correctly" classname="math.test.ts" time="0.002"></testcase>
<testcase name="basic math › multiplies two numbers correctly" classname="math.test.ts" time="0.001">
<failure message="expect(received).toBe(expected) // Object.is equality" type="expect.toBe">
<![CDATA[  math.test.ts:8:7 › basic math › multiplies two numbers correctly

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 99
    Received: 12

       7 |
       8 |   test("multiplies two numbers correctly", () => {
    >  9 |     expect(3 * 4).toBe(99);
         |                   ^
      10 |   });
        at /project/math.test.ts:9:19
]]>
</failure>
</testcase>
<testcase name="basic math › does not divide by zero" classname="math.test.ts" time="0.001">
<error message="Cannot read properties of null (reading &apos;value&apos;)" type="TypeError">
<![CDATA[  math.test.ts:12:7 › basic math › does not divide by zero

    TypeError: Cannot read properties of null (reading 'value')

      11 |
      12 |   test("does not divide by zero", () => {
    > 13 |     const result = (null as unknown as Record<string, number>).value;
         |                                                                ^
        at /project/math.test.ts:13:64
]]>
</error>
</testcase>
</testsuite>
</testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 1 passed");
      expect(result.failures![0].file).toBe("math.test.ts");
      expect(result.failures![0].line).toBe(9);
      expect(result.failures![0].message).toContain("expect(received).toBe(expected)");
      expect(result.failures![0].message).toContain("Expected: 99");
      expect(result.failures![0].message).toContain("Received: 12");
      expect(result.failures![1].file).toBe("math.test.ts");
      expect(result.failures![1].line).toBe(13);
      expect(result.failures![1].message).toBe("Cannot read properties of null (reading 'value')");
    });
  });

  describe("phpunit output", () => {
    it("extracts file:line from body when tc.line is method definition line", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <testsuites>
          <testsuite name="MathTest" file="/project/MathTest.php" tests="2" assertions="2" errors="0" failures="1">
            <testcase name="testAddsTwoNumbersCorrectly" file="/project/MathTest.php" line="9" class="MathTest" classname="MathTest" assertions="1" time="0.000"/>
            <testcase name="testMultipliesTwoNumbersCorrectly" file="/project/MathTest.php" line="14" class="MathTest" classname="MathTest" assertions="1" time="0.001">
              <failure type="PHPUnit\\Framework\\ExpectationFailedException">MathTest::testMultipliesTwoNumbersCorrectly
Failed asserting that 12 is identical to 99.

/project/MathTest.php:16</failure>
            </testcase>
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 1 passed");
      expect(result.failures![0].file).toBe("MathTest.php");
      expect(result.failures![0].line).toBe(16);
      expect(result.failures![0].message).toBe("Failed asserting that 12 is identical to 99.");
      expect(result.failures![0].rule).toBe("PHPUnit\\Framework\\ExpectationFailedException");
    });

    it("handles deeply nested testsuites (PHPUnit wraps in 3 levels)", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <testsuites>
          <testsuite name="phpunit.xml" tests="3" assertions="2" errors="1" failures="1">
            <testsuite name="default" tests="3" assertions="2" errors="1" failures="1">
              <testsuite name="MathTest" file="/project/MathTest.php" tests="3" assertions="2" errors="1" failures="1">
                <testcase name="testAddsTwoNumbersCorrectly" file="/project/MathTest.php" line="9" class="MathTest" classname="MathTest" assertions="1" time="0.000"/>
                <testcase name="testMultipliesTwoNumbersCorrectly" file="/project/MathTest.php" line="14" class="MathTest" classname="MathTest" assertions="1" time="0.001">
                  <failure type="PHPUnit\\Framework\\ExpectationFailedException">MathTest::testMultipliesTwoNumbersCorrectly
Failed asserting that 12 is identical to 99.

/project/MathTest.php:16</failure>
                </testcase>
                <testcase name="testDoesNotDivideByZero" file="/project/MathTest.php" line="19" class="MathTest" classname="MathTest" assertions="0" time="0.000">
                  <error type="DivisionByZeroError">MathTest::testDoesNotDivideByZero
DivisionByZeroError: Division by zero

/project/MathTest.php:21</error>
                </testcase>
              </testsuite>
            </testsuite>
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 1 passed");
      expect(result.failures).toHaveLength(2);
      expect(result.failures![0].file).toBe("MathTest.php");
      expect(result.failures![0].line).toBe(16);
      expect(result.failures![1].file).toBe("MathTest.php");
      expect(result.failures![1].line).toBe(21);
    });

    it("extracts file:line from error body for exceptions", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <testsuites>
          <testsuite name="MathTest" file="/project/MathTest.php" tests="1" assertions="0" errors="1" failures="0">
            <testcase name="testDoesNotDivideByZero" file="/project/MathTest.php" line="19" class="MathTest" classname="MathTest" assertions="0" time="0.000">
              <error type="DivisionByZeroError">MathTest::testDoesNotDivideByZero
DivisionByZeroError: Division by zero

/project/MathTest.php:21</error>
            </testcase>
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.status).toBe("fail");
      expect(result.failures![0].file).toBe("MathTest.php");
      expect(result.failures![0].line).toBe(21);
      expect(result.failures![0].message).toBe("DivisionByZeroError: Division by zero");
      expect(result.failures![0].rule).toBe("DivisionByZeroError");
    });
  });

  describe("pest (PHP) output", () => {
    it("handles nested testsuites and extracts file:line from Pest stack frames", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <testsuites>
          <testsuite name="phpunit.xml" tests="3" assertions="2" errors="1" failures="1" skipped="0" time="0.012">
            <testsuite name="Tests" tests="3" assertions="2" errors="1" failures="1" skipped="0" time="0.012">
              <testsuite name="Tests\\MathTest" file="tests/MathTest.php" tests="3" assertions="2" errors="1" failures="1" skipped="0" time="0.012">
                <testcase name="it adds two numbers correctly" file="tests/MathTest.php::it adds two numbers correctly" class="Tests\\MathTest" classname="Tests.MathTest" assertions="1" time="0.005"/>
                <testcase name="it multiplies two numbers correctly" file="tests/MathTest.php::it multiplies two numbers correctly" class="Tests\\MathTest" classname="Tests.MathTest" assertions="1" time="0.007">
                  <failure type="PHPUnit\\Framework\\ExpectationFailedException">it multiplies two numbers correctlyFailed asserting that 12 is identical to 99.
at tests/MathTest.php:8</failure>
                </testcase>
                <testcase name="it does not divide by zero" file="tests/MathTest.php::it does not divide by zero" class="Tests\\MathTest" classname="Tests.MathTest" assertions="0" time="0.0003">
                  <error type="DivisionByZeroError">it does not divide by zeroDivisionByZeroError: Division by zero
at tests/MathTest.php:12</error>
                </testcase>
              </testsuite>
            </testsuite>
          </testsuite>
        </testsuites>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 1 passed");
      expect(result.failures).toHaveLength(2);
      expect(result.failures![0].file).toBe("tests/MathTest.php");
      expect(result.failures![0].line).toBe(8);
      expect(result.failures![0].message).toBe("Failed asserting that 12 is identical to 99.");
      expect(result.failures![0].rule).toBe("PHPUnit\\Framework\\ExpectationFailedException");
      expect(result.failures![1].file).toBe("tests/MathTest.php");
      expect(result.failures![1].line).toBe(12);
      expect(result.failures![1].message).toBe("DivisionByZeroError: Division by zero");
      expect(result.failures![1].rule).toBe("DivisionByZeroError");
    });

    it("strips '::test name' suffix from file attributes", async () => {
      const xml = `<testsuite name="Tests\\MathTest" file="tests/MathTest.php" tests="1" failures="1" errors="0">
        <testcase name="it fails" file="tests/MathTest.php::it fails" classname="Tests.MathTest">
          <failure type="Error">it failsOops
at tests/MathTest.php:5</failure>
        </testcase>
      </testsuite>`;
      const result = await parser.parse(makeCtx(xml, "/project"));
      expect(result.failures![0].file).toBe("tests/MathTest.php");
    });
  });

  describe("multi-suite totals", () => {
    it("failures and errors summed across suites", async () => {
      const xml = `<testsuites>
        <testsuite name="s1" tests="2" failures="1" errors="0">
          ${PASSING("a")}
          ${FAILING("b", "Foo", "oops")}
        </testsuite>
        <testsuite name="s2" tests="2" failures="0" errors="1">
          ${PASSING("c")}
          ${ERROR("d", "Bar", "boom")}
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 2 passed");
      expect(result.failures).toHaveLength(2);
    });

    it("collects direct and nested testcases without double counting", async () => {
      const xml = `<testsuites>
        <testsuite name="root" tests="3" failures="2" errors="0">
          ${FAILING("direct_failure", "RootTest", "direct broke")}
          <testsuite name="nested" tests="2" failures="1" errors="0">
            ${PASSING("nested_pass", "NestedTest")}
            ${FAILING("nested_failure", "NestedTest", "nested broke")}
          </testsuite>
        </testsuite>
      </testsuites>`;
      const result = await parser.parse(makeCtx(xml));
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 1 passed");
      expect(result.failures).toHaveLength(2);
      expect(result.failures![0].message).toBe("direct broke");
      expect(result.failures![1].message).toBe("nested broke");
    });
  });

  describe("multi-file artifact paths (Gradle-style)", () => {
    it("aggregates results across multiple XML files", async () => {
      const ctx = makeMultiCtx({
        "TEST-com.example.FooTest.xml": `<testsuite name="com.example.FooTest" tests="2" failures="1" errors="0">
          ${PASSING("test_a")}
          ${FAILING("test_b", "com.example.FooTest", "expected 2 but was 1")}
        </testsuite>`,
        "TEST-com.example.BarTest.xml": `<testsuite name="com.example.BarTest" tests="3" failures="0" errors="0">
          ${PASSING("test_c")}
          ${PASSING("test_d")}
          ${PASSING("test_e")}
        </testsuite>`,
      });
      const result = await parser.parse(ctx);
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("1 failed, 4 passed");
      expect(result.failures).toHaveLength(1);
      expect(result.failures![0].message).toBe("expected 2 but was 1");
    });

    it("all passing across multiple files → status pass", async () => {
      const ctx = makeMultiCtx({
        "TEST-FooTest.xml": `<testsuite name="FooTest" tests="2" failures="0" errors="0">
          ${PASSING("a")}
          ${PASSING("b")}
        </testsuite>`,
        "TEST-BarTest.xml": `<testsuite name="BarTest" tests="1" failures="0" errors="0">
          ${PASSING("c")}
        </testsuite>`,
      });
      const result = await parser.parse(ctx);
      expect(result.status).toBe("pass");
      expect(result.summary).toBe("3 passed");
      expect(result.failures).toHaveLength(0);
    });

    it("failures across multiple files are all collected", async () => {
      const ctx = makeMultiCtx({
        "TEST-FooTest.xml": `<testsuite name="FooTest" tests="2" failures="1" errors="0">
          ${PASSING("a")}
          ${FAILING("b", "FooTest", "foo broke")}
        </testsuite>`,
        "TEST-BarTest.xml": `<testsuite name="BarTest" tests="2" failures="0" errors="1">
          ${PASSING("c")}
          ${ERROR("d", "BarTest", "bar exploded")}
        </testsuite>`,
      });
      const result = await parser.parse(ctx);
      expect(result.status).toBe("fail");
      expect(result.summary).toBe("2 failed, 2 passed");
      expect(result.failures).toHaveLength(2);
      expect(result.failures![0].message).toBe("foo broke");
      expect(result.failures![1].message).toBe("bar exploded");
    });

    it("skips empty artifact files gracefully", async () => {
      const ctx = makeMultiCtx({
        "TEST-FooTest.xml": `<testsuite name="FooTest" tests="1" failures="0" errors="0">
          ${PASSING("a")}
        </testsuite>`,
        "TEST-Empty.xml": "",
      });
      const result = await parser.parse(ctx);
      expect(result.status).toBe("pass");
      expect(result.summary).toBe("1 passed");
    });
  });
});
