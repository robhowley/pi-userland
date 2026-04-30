import fs from "node:fs";

/**
 * Safely read a file, returning empty string if it doesn't exist.
 * Handles the case where a command was killed before writing output.
 */
export function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Extract the first user-code file:line from a JS/TS stack trace string.
 * Skips node_modules and Node.js internal frames.
 *
 * Handles both formats:
 *   at functionName (file.ts:10:5)
 *   at file.ts:10:5
 */
export function extractJsStackLocation(stack: string | undefined): { file?: string; line?: number } {
  if (!stack) return {};
  for (const line of stack.split("\n")) {
    // "at name (file:line:col)"
    const withParens = line.match(/at\s+\S+\s+\(([^)]+\.(?:[jt]sx?|mjs|cjs)):(\d+):\d+\)/);
    if (withParens && isUserFrame(withParens[1])) {
      return { file: withParens[1], line: Number(withParens[2]) };
    }
    // "at file:line:col" (no parens)
    const bare = line.match(/at\s+([^\s(]+\.(?:[jt]sx?|mjs|cjs)):(\d+):\d+/);
    if (bare && isUserFrame(bare[1])) {
      return { file: bare[1], line: Number(bare[2]) };
    }
  }
  return {};
}

function isUserFrame(filePath: string): boolean {
  return !filePath.includes("node_modules") && !filePath.includes("node:");
}
