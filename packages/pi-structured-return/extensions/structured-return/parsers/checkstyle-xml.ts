import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { ParserModule, ParsedFailure } from '../types';

interface CheckstyleError {
  line?: string | number;
  column?: string | number;
  message?: string;
  source?: string;
  severity?: string;
}

interface CheckstyleFile {
  name: string;
  error?: CheckstyleError | CheckstyleError[];
}

interface CheckstyleDocument {
  '?xml'?: { version: string; encoding: string };
  checkstyle?: {
    version?: string;
    file?: CheckstyleFile | CheckstyleFile[];
  };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'error',
});

/** Normalize a file path: relativize absolute paths, passthrough relative. */
function normalizePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(cwd, path.resolve(filePath));
  }
  return filePath;
}

/** Shorten Java FQCN source names, preserve category:id format. */
function normalizeRule(source?: string): string | undefined {
  if (!source) return undefined;

  // category:id format (e.g., "standard:semicolon") — keep unchanged
  if (source.includes(':')) return source;

  // Java FQCN format (e.g., "com.foo.BarCheck") — extract short name
  const fqcnMatch = source.match(/\.([A-Z][a-zA-Z0-9]*Check)$/);
  if (fqcnMatch) return fqcnMatch[1];

  // Keep other sources as-is
  return source;
}

/** Generate a unique finding ID. */
function generateId(file: string, line?: number, rule?: string): string {
  return `${file}:${line ?? 0}:${rule ?? 'unknown'}`;
}

/** Check if severity should be filtered (ignored). */
function isIgnoredSeverity(severity?: string): boolean {
  return severity === 'ignore';
}

/** Extract severity category from the severity string. */
function getSeverityCategory(severity?: string): 'error' | 'warning' | 'info' | 'unknown' {
  if (!severity) return 'error'; // Default to error if missing
  const sev = severity.toLowerCase();
  if (sev === 'error' || sev === 'critical' || sev === 'fatal') return 'error';
  if (sev === 'warning' || sev === 'warn') return 'warning';
  if (sev === 'info' || sev === 'information') return 'info';
  return 'unknown';
}

const parser: ParserModule = {
  id: 'checkstyle-xml',
  async parse(ctx) {
    const artifactSources = ctx.artifactPaths.length > 0 ? ctx.artifactPaths : [ctx.stdoutPath];

    const allErrors: ParsedFailure[] = [];
    let errorCount = 0;
    let warningCount = 0;
    let infoCount = 0;

    for (const artifactPath of artifactSources) {
      let xml: string;
      try {
        xml = fs.readFileSync(artifactPath, 'utf8');
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          // File not found - skip it
          continue;
        }
        throw err;
      }

      if (!xml.trim()) continue;

      let doc: CheckstyleDocument;
      try {
        doc = xmlParser.parse(xml) as CheckstyleDocument;
      } catch {
        return {
          tool: 'checkstyle',
          status: 'error',
          summary: 'failed to parse checkstyle XML output',
          failures: [],
          logPath: ctx.logPath,
        };
      }

      const files = Array.isArray(doc.checkstyle?.file)
        ? doc.checkstyle.file
        : doc.checkstyle?.file
          ? [doc.checkstyle.file]
          : [];

      for (const file of files) {
        if (!file.name) continue;

        const normalizedFile = normalizePath(file.name, ctx.cwd);
        const errors = Array.isArray(file.error) ? file.error : file.error ? [file.error] : [];

        for (const err of errors) {
          // Skip ignored severity
          if (isIgnoredSeverity(err.severity)) continue;

          const line = err.line !== undefined ? Number(err.line) : undefined;
          const rule = normalizeRule(err.source);

          const failure: ParsedFailure = {
            id: generateId(normalizedFile, line, rule),
            file: normalizedFile,
            line: Number.isNaN(line) ? undefined : line,
            message: err.message?.trim() || undefined,
            rule: rule,
          };

          // Track severity for summary - count per category
          const sevCategory = getSeverityCategory(err.severity);
          if (sevCategory === 'error') errorCount++;
          else if (sevCategory === 'warning') warningCount++;
          else if (sevCategory === 'info') infoCount++;

          allErrors.push(failure);
        }
      }
    }

    // Determine status and build summary
    let status: 'pass' | 'fail' | 'error';
    let summary: string;

    if (allErrors.length === 0) {
      status = 'pass';
      summary = 'no lint errors';
    } else {
      // Default to fail on any finding (error or warning), pass only on info
      status = errorCount > 0 || warningCount > 0 ? 'fail' : 'pass';

      // Build summary
      if (allErrors.length === 0) {
        summary = 'no lint errors';
      } else {
        const parts = [];
        if (errorCount > 0) parts.push(`${errorCount} errors`);
        if (warningCount > 0) parts.push(`${warningCount} warnings`);
        if (infoCount > 0) parts.push(`${infoCount} info`);
        summary = `${allErrors.length} findings (${parts.join(', ')})`;
      }
    }

    return {
      tool: 'checkstyle',
      status,
      summary,
      failures: allErrors,
      logPath: ctx.logPath,
    };
  },
};

export default parser;
