import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverSources } from '../extensions/remembrancer/discovery.js';
import type { Source } from '../extensions/remembrancer/evidence.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(file: string, id: string, text = id): Source {
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id, cwd: '/work' }),
      JSON.stringify({
        type: 'message',
        id: 'message',
        parentId: null,
        timestamp: '2026-01-20T00:00:00.000Z',
        message: { role: 'user', content: text },
      }),
      '',
    ].join('\n'),
  );
  return { file, sessionId: id };
}

it('scans every cwd bucket for default storage but keeps custom storage flat', () => {
  const root = mkdtempSync(join(tmpdir(), 'remembrancer-discovery-default-'));
  roots.push(root);
  const sessionsRoot = join(root, 'sessions');
  const currentBucket = join(sessionsRoot, '--current--');
  const otherBucket = join(sessionsRoot, '--other--');
  const custom = join(root, 'custom');
  mkdirSync(currentBucket, { recursive: true });
  mkdirSync(otherBucket);
  mkdirSync(custom);
  session(join(currentBucket, 'current.jsonl'), 'current');
  session(join(otherBucket, 'other.jsonl'), 'other');
  session(join(custom, 'custom.jsonl'), 'custom');

  const defaultResult = discoverSources(currentBucket, [], '2026-01-16T00:00:00.000Z', true);
  expect(defaultResult.sources.map((source) => source.sessionId)).toEqual(['current', 'other']);

  const customResult = discoverSources(custom, [], '2026-01-16T00:00:00.000Z');
  expect(customResult.sources.map((source) => source.sessionId)).toEqual(['custom']);
});

it('discovers every valid session in the active archive, including never-enrolled workers', () => {
  const root = mkdtempSync(join(tmpdir(), 'remembrancer-discovery-'));
  roots.push(root);
  const enrolledFile = join(root, 'enrolled.jsonl');
  const workerFile = join(root, 'worker.jsonl');
  const enrolled = session(enrolledFile, 'enrolled');
  const worker = session(workerFile, 'worker');

  const result = discoverSources(
    root,
    [{ ...enrolled, seedSince: null }],
    '2026-01-16T00:00:00.000Z',
  );

  expect(result.incomplete).toBe(false);
  expect(result.sources.map((source) => source.sessionId)).toEqual(['enrolled', 'worker']);
  expect(result.newSources).toEqual([{ ...worker, seedSince: '2026-01-16T00:00:00.000Z' }]);
  expect(result.snapshots.map((snapshot) => snapshot.source.sessionId)).toEqual([
    'enrolled',
    'worker',
  ]);
  expect(result.sources).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ sessionId: 'outside' })]),
  );
});

it('reports malformed archive entries, inaccessible roots, and duplicate identities as incomplete', () => {
  const root = mkdtempSync(join(tmpdir(), 'remembrancer-discovery-errors-'));
  roots.push(root);
  const valid = session(join(root, 'valid.jsonl'), 'valid');
  writeFileSync(join(root, 'broken.jsonl'), '{broken\n');
  const duplicate = session(join(root, 'duplicate.jsonl'), 'duplicate');
  const duplicateCopy = join(root, 'duplicate-copy.jsonl');
  writeFileSync(duplicateCopy, readFile(duplicate.file));

  const result = discoverSources(root, [], '2026-01-16T00:00:00.000Z');
  expect(result.sources).toEqual([{ ...valid, seedSince: '2026-01-16T00:00:00.000Z' }]);
  expect(result.incomplete).toBe(true);
  expect(result.warnings.join('\n')).toMatch(/broken|duplicate/);

  const missing = discoverSources(join(root, 'missing'), [], '2026-01-16T00:00:00.000Z');
  expect(missing.sources).toEqual([]);
  expect(missing.incomplete).toBe(true);
  expect(missing.warnings.join('\n')).toMatch(/unable to enumerate/);
});

it('keeps conflicting enrolled identities on one path and completes the matching identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'remembrancer-discovery-same-path-'));
  roots.push(root);
  const file = join(root, 'session.jsonl');
  const matching = session(file, 'matching');
  const conflicting = { file, sessionId: 'conflicting', seedSince: null };

  const result = discoverSources(
    root,
    [{ ...matching, seedSince: null }, conflicting],
    '2026-01-16T00:00:00.000Z',
  );

  expect(result.sources).toEqual([{ ...matching, seedSince: null }, conflicting]);
  expect(result.snapshots.map((snapshot) => snapshot.source.sessionId)).toEqual([
    'matching',
    'conflicting',
  ]);
  expect(result.newSources).toEqual([]);
  expect(result.incomplete).toBe(true);
  expect(result.warnings.join('\n')).toContain('session header ID changed');
});

it('keeps an enrolled path when another archive file claims its session ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'remembrancer-discovery-collision-'));
  roots.push(root);
  const enrolledFile = join(root, 'enrolled.jsonl');
  const otherFile = join(root, 'other.jsonl');
  const enrolled = session(enrolledFile, 'same');
  session(otherFile, 'same');

  const result = discoverSources(
    root,
    [{ ...enrolled, seedSince: null }],
    '2026-01-16T00:00:00.000Z',
  );

  expect(result.sources).toEqual([]);
  expect(result.newSources).toEqual([]);
  expect(result.snapshots).toEqual([]);
  expect(result.incomplete).toBe(true);
  expect(result.warnings.join('\n')).toContain('multiple archive files');
});

function readFile(file: string): string {
  return readFileSync(file, 'utf8');
}
