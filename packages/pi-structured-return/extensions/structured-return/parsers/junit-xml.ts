import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { ParserModule, ParsedFailure } from "../types";
import { safeReadFile } from "./utils";

interface JUnitFailureOrError {
  message?: string;
  type?: string;
  "#text"?: string;
}

interface JUnitTestCase {
  name?: string;
  classname?: string;
  file?: string;
  line?: string | number;
  failure?: JUnitFailureOrError;
  error?: JUnitFailureOrError;
}

interface JUnitTestSuite {
  name?: string;
  file?: string;
  tests?: string | number;
  failures?: string | number;
  errors?: string | number;
  testcase?: JUnitTestCase[];
  testsuite?: JUnitTestSuite[]; // PHPUnit nests testsuites
  "system-out"?: string;
}

interface JUnitDocument {
  testsuites?: { testsuite?: JUnitTestSuite[] };
  testsuite?: JUnitTestSuite[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["testsuite", "testcase"].includes(name),
});

/** Decode numeric XML character references (e.g. &#xA; → newline) in attribute values. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

/** Strip a Pest-style test name prefix from a failure body.
 *  Pest can concatenate the test name directly with the error message, e.g.
 *  "it multiplies two numbers correctlyFailed asserting that 12 is identical to 99." */
function stripPestTestNamePrefix(text: string, testName?: string): string {
  if (!testName || !text.startsWith(testName)) return text;
  return text.slice(testName.length).trimStart();
}

/** Extract Expected/Received/Actual diff lines from a failure body, e.g. Jest assertion output. */
function extractAssertionDiff(text: string): string | undefined {
  const diffLines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^(Expected|Received|Actual)\s*:/.test(trimmed)) diffLines.push(trimmed);
  }
  return diffLines.length > 0 ? diffLines.join("\n") : undefined;
}

/** Extract file, line, and message from failure body text.
 *  Handles:
 *  - pytest-style: "file.py:line: message"
 *  - Go-style: "    file.go:line: message"
 *  - Playwright-style: "at /path/file.ts:line:col"
 *  - Pest-style: "at tests/MathTest.php:8"
 *  - PHPUnit-style: "/path/to/File.php:21" trailer lines
 *  - .NET-style: "in /path/File.cs:line N"
 *  - Java/JVM-style: "at [module/]pkg.Class.method(File.java:N)"
 *    preferring the frame whose class matches `classname`. */
function parseBodyLocation(
  text: string,
  classname?: string
): { file: string; line: number; message?: string } | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const phpMessage = () =>
    lines.find((l) => !/^\w+::\w+/.test(l) && !/^at\s+.+?\.php:\d+$/.test(l) && !/^.+?\.php:\d+$/.test(l));

  // Check stack frames first so Playwright/Jest locations win over header lines like
  // "math.test.ts:8:7 › suite › test", which would otherwise match the generic file:line pattern.
  for (const line of lines) {
    const m = line.match(/^at\s+\S+\s+\(([^)]+\.(?:[jt]sx?|mjs|cjs)):(\d+):\d+\)/);
    if (m && !m[1].includes("node_modules")) {
      return { file: path.basename(m[1]), line: Number(m[2]) };
    }
  }

  for (const line of lines) {
    const m = line.match(/^at\s+(.+?\.(?:[jt]sx?|mjs|cjs)):(\d+):\d+$/);
    if (m && !m[1].includes("node_modules")) {
      return { file: path.basename(m[1]), line: Number(m[2]) };
    }
  }

  for (const line of lines) {
    const m = line.match(/^at\s+(.+?\.php):(\d+)$/);
    if (m) return { file: m[1], line: Number(m[2]) };
  }

  // pytest / Go: "file.ext:line: message"
  for (const line of lines) {
    const m = line.match(/^([^:\s]+\.\w+):(\d+):\s*(.*)/);
    if (m) return { file: m[1], line: Number(m[2]), message: m[3] || undefined };
  }

  // .NET: "in /path/File.cs:line N"
  for (const line of lines) {
    const m = line.match(/\bin ([^\s]+\.(?:cs|fs|vb)):line (\d+)/);
    if (m) return { file: path.basename(m[1]), line: Number(m[2]) };
  }

  // Java/JVM: "at [module/]pkg.Class.method(File.java:N)"
  const javaRe = /^at (?:[\w.$]+\/)?([\w.$]+)\.\w+\(([\w]+\.(?:java|kt|scala|groovy)):(\d+)\)$/;
  const frameworkPrefixes = ["java.", "javax.", "sun.", "com.sun.", "org.junit.", "org.opentest4j.", "junit."];
  const simpleClass = classname?.split(".").pop();
  let firstUserFrame: { file: string; line: number } | undefined;

  for (const line of lines) {
    const m = line.match(javaRe);
    if (!m) continue;
    const [, cls, file, lineNum] = m;
    if (simpleClass && cls === simpleClass) return { file, line: Number(lineNum) };
    if (!firstUserFrame && !frameworkPrefixes.some((p) => cls.startsWith(p))) {
      firstUserFrame = { file, line: Number(lineNum) };
    }
  }

  if (firstUserFrame) return firstUserFrame;

  for (const line of lines) {
    const m = line.match(/^(.+?\.php):(\d+)$/);
    if (m) return { file: m[1], line: Number(m[2]), message: phpMessage() };
  }

  for (const line of lines) {
    const m = line.match(/(?:^#\d+\s+)?(.+?\.php)\((\d+)\)(?::|$)/);
    if (m) return { file: m[1], line: Number(m[2]), message: phpMessage() };
  }

  return undefined;
}

/** Extract panic message and file:line for a specific test from Go's system-out. */
function parsePanicInfo(
  systemOut: string,
  testName: string
): { message?: string; file?: string; line?: number } | undefined {
  const lines = systemOut.split("\n");
  const panicLine = lines.find((l) => l.trim().startsWith("panic:"));
  if (!panicLine) return undefined;
  const message = panicLine
    .trim()
    .replace(/^panic:\s*/, "")
    .replace(/\s*\[.*\]$/, "")
    .trim();

  // Find the stack frame for this test function, then grab the file:line on the next line
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes(`.${testName}(`)) {
      const m = lines[i + 1].trim().match(/^([^:]+\.go):(\d+)/);
      if (m) return { message, file: m[1].split("/").pop(), line: Number(m[2]) };
    }
  }
  return { message };
}

function resolveClassnameFile(classname?: string): string | undefined {
  if (!classname) return undefined;
  const normalized = classname.replace(/\\/g, "/");
  if (/\.(?:[jt]sx?|mjs|cjs|py|rb|go|php|cs|fs|vb|java|kt|scala|groovy)$/.test(normalized)) {
    return normalized;
  }
  if (normalized.includes("/")) return undefined;
  if (/^[\w$]+(?:\.[\w$]+)*$/.test(classname)) {
    return classname.replace(/\./g, "/") + ".java";
  }
  return undefined;
}

function resolveFile(tc: JUnitTestCase, suite: JUnitTestSuite, cwd: string): string | undefined {
  const raw = (tc.file ?? suite.file)?.split("::")[0];
  if (raw) return path.relative(cwd, path.resolve(cwd, raw));
  return resolveClassnameFile(tc.classname);
}

function isPhpFile(candidate?: string): boolean {
  if (!candidate) return false;
  return candidate.split("::")[0].replace(/\\/g, "/").endsWith(".php");
}

/** Recursively collect all testsuites including nested ones (PHPUnit/Pest style). */
function flattenSuites(suites: JUnitTestSuite[]): JUnitTestSuite[] {
  const result: JUnitTestSuite[] = [];
  for (const suite of suites) {
    result.push(suite);
    if (suite.testsuite) {
      result.push(...flattenSuites(suite.testsuite));
    }
  }
  return result;
}

const parser: ParserModule = {
  id: "junit-xml",
  async parse(ctx) {
    const artifactSources = ctx.artifactPaths.length > 0 ? ctx.artifactPaths : [ctx.stdoutPath];

    let totalTests = 0;
    let totalFailed = 0;
    const failures: ParsedFailure[] = [];

    for (const artifactPath of artifactSources) {
      const xml = safeReadFile(artifactPath);
      if (!xml.trim()) continue;
      const doc = xmlParser.parse(xml) as JUnitDocument;

      const topLevelSuites: JUnitTestSuite[] = doc.testsuites?.testsuite ?? doc.testsuite ?? [];

      // Count tests/failures from top-level only (nested suites report aggregates)
      for (const suite of topLevelSuites) {
        totalTests += Number(suite.tests ?? 0);
        totalFailed += Number(suite.failures ?? 0) + Number(suite.errors ?? 0);
      }

      // Process testcases from all suites including nested ones (PHPUnit nests testsuites)
      const allSuites = flattenSuites(topLevelSuites);

      for (const suite of allSuites) {
        for (const tc of suite.testcase ?? []) {
          const rawProblem = tc.failure ?? tc.error;
          if (!rawProblem) continue;
          const problem: JUnitFailureOrError = typeof rawProblem === "string" ? { "#text": rawProblem } : rawProblem;

          const bodyLocation = problem["#text"] ? parseBodyLocation(problem["#text"], tc.classname) : undefined;
          const panicInfo =
            !bodyLocation && suite["system-out"] && tc.name ? parsePanicInfo(suite["system-out"], tc.name) : undefined;
          const file =
            (tc.file ?? suite.file)
              ? resolveFile(tc, suite, ctx.cwd)
              : (bodyLocation?.file ?? panicInfo?.file ?? resolveFile(tc, suite, ctx.cwd));
          const tcLine = tc.line !== undefined ? Number(tc.line) : undefined;
          // PHPUnit/Pest report tc.line as the test method definition line, not the failure line.
          // Other JUnit producers historically prefer tc.line when it is present.
          const preferBodyLine =
            isPhpFile(file) || isPhpFile(tc.file) || isPhpFile(suite.file) || isPhpFile(bodyLocation?.file);
          const line = preferBodyLine
            ? (bodyLocation?.line ?? panicInfo?.line ?? tcLine)
            : (tcLine ?? bodyLocation?.line ?? panicInfo?.line);
          const id = [file, line, tc.name].filter(Boolean).join(":");

          failures.push({
            id: id || String(failures.length),
            file,
            line: Number.isNaN(line) ? undefined : line,
            message: (() => {
              let raw =
                problem.message && problem.message.toLowerCase() !== "failed"
                  ? problem.message
                  : (bodyLocation?.message ??
                    panicInfo?.message ??
                    problem.message ??
                    problem["#text"]?.trim().split("\n")[0]);
              if (!raw) return undefined;
              raw = stripPestTestNamePrefix(raw, tc.name);
              const decoded = decodeXmlEntities(raw);
              // Append assertion diff lines (Expected/Received/Actual) from the body when not already present.
              // Covers Jest-style failures where the diff follows the error type line in #text.
              if (
                problem["#text"] &&
                !decoded.includes("Expected") &&
                !decoded.includes("Received") &&
                !decoded.includes("Actual")
              ) {
                const diff = extractAssertionDiff(problem["#text"]);
                if (diff) return `${decoded}\n${diff}`;
              }
              return decoded;
            })(),
            rule: problem.type,
          });
        }
      }
    }

    const passed = totalTests - totalFailed;

    return {
      tool: "junit",
      status: totalFailed > 0 ? "fail" : "pass",
      summary: totalFailed > 0 ? `${totalFailed} failed, ${passed} passed` : `${passed} passed`,
      failures,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
