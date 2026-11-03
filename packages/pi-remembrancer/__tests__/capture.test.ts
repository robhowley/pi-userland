import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { branchEvidence, prepareReview, readSession } from '../extensions/remembrancer/capture.js';

const msg = (id: string, parentId: string | null, text = id) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-30',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const lines = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';

it('restart sees sibling leaves and later appends do not expand an earlier review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-tree-'));
  try {
    const file = join(dir, 'parent.jsonl');
    writeFileSync(
      file,
      lines({ type: 'session', id: 'p' }, msg('root', null), msg('a', 'root'), msg('b', 'root')),
    );
    const first = readSession(file);
    expect(first.tips.map((tip) => tip.entryId)).toEqual(['a', 'b']);

    appendFileSync(file, lines(msg('later', 'a')));
    const recovered = readSession(file);
    expect(recovered.tips.map((tip) => tip.entryId)).toEqual(['b', 'later']);
    expect(branchEvidence(recovered, first.tips[0]!).map((entry) => entry.text)).toEqual([
      'root',
      'a',
    ]);

    const fork = join(dir, 'fork.jsonl');
    writeFileSync(
      fork,
      lines({ type: 'session', id: 'f', parentSession: file }, msg('root', null), msg('f', 'root')),
    );
    const copied = readSession(fork);
    const sourceMap = new Map([
      [file, recovered],
      [fork, copied],
    ]);
    const before = branchEvidence(recovered, first.tips[0]!, sourceMap);
    const after = branchEvidence(copied, copied.tips[0]!, sourceMap);
    expect(
      after
        .filter((entry) => !before.some((previous) => previous.key === entry.key))
        .map((entry) => entry.text),
    ).toEqual(['f']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('torn tail is retryable and interior corruption cannot silently advance a checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-tail-'));
  try {
    const file = join(dir, 'log');
    writeFileSync(file, lines({ type: 'session', id: 'p' }, msg('a', null)) + '{"type"');
    expect(readSession(file).tips.map((tip) => tip.entryId)).toEqual(['a']);
    appendFileSync(file, '\n' + lines(msg('b', 'a')));
    expect(() => readSession(file)).toThrow(/Invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('a newer context edit hides text on older queued checkpoints, and both are covered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-edit-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      lines({ type: 'session', id: 'p', cwd: '/work' }, msg('a', null, 'removed text')),
    );
    const original = readSession(file).tips[0]!;
    appendFileSync(
      file,
      lines(
        { type: 'context_edit', id: 'redact', parentId: 'a', targetId: 'a', replacement: null },
        msg('b', 'redact'),
      ),
    );
    const latest = readSession(file).tips[0]!;
    const batch = prepareReview([original, latest], []);
    expect(batch.tips).toEqual([original, latest]);
    expect(batch.evidence.map((entry) => [entry.text, entry.cwd, entry.timestamp])).toEqual([
      ['b', '/work', '2026-01-30'],
    ]);
    expect(batch.warnings).toEqual([]);
    expect(prepareReview([original], [latest]).evidence).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('incremental review reuses source coverage across a fork and ignores unrelated historic files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-incremental-'));
  try {
    const file = join(dir, 'parent.jsonl');
    const fork = join(dir, 'fork.jsonl');
    writeFileSync(file, lines({ type: 'session', id: 'p' }, msg('a', null), msg('b', 'a')));
    const first = readSession(file).tips[0]!;
    writeFileSync(
      fork,
      lines(
        { type: 'session', id: 'f', parentSession: file },
        msg('a', null),
        msg('b', 'a'),
        msg('c', 'b'),
      ),
    );
    const child = readSession(fork).tips[0]!;
    const unrelated = { ...first, file: join(dir, 'deleted.jsonl') };
    const batch = prepareReview([child], [unrelated, first]);
    expect(batch.evidence.map((entry) => [entry.text, entry.cwd])).toEqual([['c', '(unknown)']]);
    expect(batch.warnings).toEqual([]);

    appendFileSync(fork, lines(msg('d', 'c')));
    const next = readSession(fork).tips[0]!;
    expect(prepareReview([next], [first, child]).evidence.map((entry) => entry.text)).toEqual([
      'd',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects invalid roots, duplicate entry IDs, and unknown review boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-invalid-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, lines({ type: 'session', id: 'p' }, msg('a', null), msg('a', 'a')));
    expect(() => readSession(file)).toThrow(/Invalid session tree/);
    writeFileSync(file, lines({ type: 'session', id: 'p' }, msg('b', 'missing')));
    expect(() => readSession(file)).toThrow(/Invalid session tree/);

    writeFileSync(file, lines({ type: 'session', id: 'p' }, msg('a', null)));
    const tree = readSession(file);
    expect(() => branchEvidence(tree, { file, sessionId: 'p', entryId: 'missing' })).toThrow(
      /Unknown review boundary/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
