import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createMemoryArchive,
  MAX_ARCHIVE_BYTES,
  MEMORY_HEAP_MEBIBYTES,
  type MemoryArchive,
} from './fixtures/memory-archive.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const tsc = join(repoRoot, 'node_modules/.bin/tsc');
const child = join(packageRoot, '__tests__/fixtures/memory-child.mjs');
const workRoot = mkdtempSync(join(tmpdir(), 'remembrancer-memory-test-'));
let archive: MemoryArchive;
let evidenceModule: string;
let discoveryModule: string;

beforeAll(() => {
  archive = createMemoryArchive(join(workRoot, 'archive'));
  expect(archive.diskBytes).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);

  const output = join(workRoot, 'compiled');
  const result = spawnSync(
    tsc,
    [
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--outDir',
      output,
      '--rootDir',
      join(packageRoot, 'extensions'),
      '--skipLibCheck',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
      '--pretty',
      'false',
      join(packageRoot, 'extensions/remembrancer/checkpoints.ts'),
      join(packageRoot, 'extensions/remembrancer/discovery.ts'),
      join(packageRoot, 'extensions/remembrancer/evidence.ts'),
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0)
    throw new Error(
      `TypeScript compilation failed (${result.status ?? result.signal}): ${result.stdout}${result.stderr}`,
    );

  evidenceModule = join(output, 'remembrancer/evidence.js');
  discoveryModule = join(output, 'remembrancer/discovery.js');
});

afterAll(() => rmSync(workRoot, { recursive: true, force: true }));

function runChild(mode: 'memory' | 'limit') {
  // Run through a shell only to apply RLIMIT_CORE=0 before exec. The child has
  // the package's declared Node heap and a hard wall-clock limit, not a host RSS threshold.
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      'ulimit -c 0; exec "$@"',
      'remembrancer-memory-child',
      process.execPath,
      `--max-old-space-size=${MEMORY_HEAP_MEBIBYTES}`,
      '--unhandled-rejections=strict',
      child,
      evidenceModule,
      discoveryModule,
      archive.root,
      archive.nearLimitFile,
      archive.overLimitFile,
      mode,
    ],
    { cwd: packageRoot, encoding: 'utf8', timeout: 60_000 },
  );
}

function childDiagnostic(result: ReturnType<typeof runChild>) {
  return [
    `status=${result.status ?? 'null'}`,
    `signal=${result.signal ?? 'none'}`,
    result.error ? `error=${result.error.message}` : '',
    `stdout=${result.stdout}`,
    `stderr=${result.stderr}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function childSummary(result: ReturnType<typeof runChild>) {
  expect(result.status, childDiagnostic(result)).toBe(0);
  const output = result.stdout.trim().split('\n').at(-1);
  expect(output, childDiagnostic(result)).toBeTruthy();
  return JSON.parse(output!);
}

it('completes a tool/image-heavy archive under a constrained V8 heap', () => {
  const summary = childSummary(runChild('memory'));
  expect(summary).toMatchObject({
    ok: true,
    mode: 'memory',
    sources: 7,
    evidence: 14,
    contextBranches: 7,
  });
  expect(summary.heapUsed).toEqual(expect.any(Number));
  expect(summary.rss).toEqual(expect.any(Number));
  expect(summary.maxRSS).toEqual(expect.any(Number));
});

it('accepts a near-limit record and rejects a raw record over the limit', () => {
  const summary = childSummary(runChild('limit'));
  expect(summary).toMatchObject({ ok: true, mode: 'limit' });
  expect(summary.heapUsed).toEqual(expect.any(Number));
  expect(summary.rss).toEqual(expect.any(Number));
  expect(summary.maxRSS).toEqual(expect.any(Number));
});
