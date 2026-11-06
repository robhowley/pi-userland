import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  prepareReview,
  resolveSeedSince,
  type Source,
} from '../extensions/remembrancer/evidence.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const msg = (id: string, parentId: string | null, text = id, timestamp = '2026-01-30') => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const lines = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';
function fixture(...records: unknown[]): Source {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-evidence-'));
  dirs.push(dir);
  const source = { file: join(dir, 'session.jsonl'), sessionId: dir };
  writeFileSync(
    source.file,
    lines({ type: 'session', id: source.sessionId, cwd: '/work' }, ...records),
  );
  return source;
}
const texts = (review: ReturnType<typeof prepareReview>) =>
  review.evidence.map((item) => item.text);

it('resolves only positive integer day seeds to an inclusive absolute UTC instant', () => {
  expect(resolveSeedSince('14d', '2026-01-30T12:00:00.000Z')).toBe('2026-01-16T12:00:00.000Z');
  for (const value of ['0d', '-1d', '1.5d', '14 D', '2026-01-16', '999999999999999999999d'])
    expect(() => resolveSeedSince(value, '2026-01-30T12:00:00.000Z')).toThrow();
});

it('includes an evidence timestamp exactly at the requested UTC cutoff', () => {
  const source = fixture(
    msg('before', null, 'before', '2026-01-15T11:59:59.999Z'),
    msg('at', 'before', 'at', '2026-01-15T12:00:00.000Z'),
  );
  const review = prepareReview([source], [], {
    requestedSince: '2026-01-15T12:00:00.000Z',
  });
  expect(texts(review)).toEqual(['at']);
});

it('selects a requested date, then expands an unchanged tip without replaying covered versions', () => {
  const source = fixture(
    msg('old', null, 'old', '2025-12-31T00:00:00.000Z'),
    msg('recent', 'old', 'recent', '2026-01-20T00:00:00.000Z'),
  );
  const first = prepareReview([source], [], {
    requestedSince: '2026-01-15T00:00:00.000Z',
  });
  expect(texts(first)).toEqual(['recent']);
  expect(first.checkpoints).toEqual([
    { ...source, entryId: 'recent', since: '2026-01-15T00:00:00.000Z' },
  ]);
  expect(first.sourceDefaults).toEqual([
    { sessionId: source.sessionId, since: '2026-01-15T00:00:00.000Z' },
  ]);

  const expanded = prepareReview([source], first.checkpoints, {
    requestedSince: '2025-12-01T00:00:00.000Z',
  });
  expect(texts(expanded)).toEqual(['old']);
  expect(expanded.checkpoints).toEqual([
    { ...source, entryId: 'recent', since: '2025-12-01T00:00:00.000Z' },
  ]);

  const empty = prepareReview([source], expanded.checkpoints, {
    requestedSince: '2025-11-01T00:00:00.000Z',
  });
  expect(texts(empty)).toEqual([]);
  expect(empty.coverageChanged).toBe(true);
  const noOp = prepareReview(
    [{ ...source, seedSince: '2025-11-01T00:00:00.000Z' }],
    empty.checkpoints,
    { requestedSince: '2025-12-01T00:00:00.000Z' },
  );
  expect(texts(noOp)).toEqual([]);
  expect(noOp.coverageChanged).toBe(false);
});

it('combines backward expansion with pending recent evidence before advancing the tip', () => {
  const source = fixture(
    msg('old', null, 'old', '2025-12-31T00:00:00.000Z'),
    msg('recent', 'old', 'recent', '2026-01-20T00:00:00.000Z'),
  );
  const first = prepareReview([source], [], {
    requestedSince: '2026-01-15T00:00:00.000Z',
  });
  appendFileSync(
    source.file,
    lines(msg('pending', 'recent', 'pending', '2026-01-25T00:00:00.000Z')),
  );

  const expanded = prepareReview([source], first.checkpoints, {
    requestedSince: '2025-12-01T00:00:00.000Z',
  });
  expect(texts(expanded)).toEqual(['old', 'pending']);
  expect(expanded.checkpoints).toEqual([
    { ...source, entryId: 'pending', since: '2025-12-01T00:00:00.000Z' },
  ]);
});

it('uses a seeded session default for an uncheckpointed fork without inheriting sibling proof', () => {
  const source = fixture(
    msg('root', null, 'root', '2026-01-01T00:00:00.000Z'),
    msg('a', 'root', 'a', '2026-01-20T00:00:00.000Z'),
    msg('b', 'root', 'b', '2026-01-18T00:00:00.000Z'),
  );
  const review = prepareReview(
    [{ ...source, seedSince: '2026-01-16T00:00:00.000Z' }],
    [{ ...source, entryId: 'a', since: '2026-01-16T00:00:00.000Z' }],
  );
  expect(texts(review)).toEqual(['b']);
  expect(review.tips.map((tip) => tip.entryId)).toEqual(['b']);
});

it('uses the applied edit timestamp and includes unknown-time versions without incomplete status', () => {
  const source = fixture(
    msg('root', null, 'original', '2025-12-01T00:00:00.000Z'),
    {
      type: 'context_edit',
      id: 'edit',
      parentId: 'root',
      targetId: 'root',
      timestamp: '2026-01-20T00:00:00.000Z',
      replacement: { content: 'corrected' },
    },
    msg('child', 'edit', 'child', '2026-01-21T00:00:00.000Z'),
  );
  const edited = prepareReview([source], [], {
    requestedSince: '2026-01-15T00:00:00.000Z',
  });
  expect(edited.evidence.map((item) => [item.entryId, item.editId, item.timestamp])).toEqual([
    ['root', 'edit', '2026-01-20T00:00:00.000Z'],
    ['child', null, '2026-01-21T00:00:00.000Z'],
  ]);

  const unknownSource = fixture(
    msg('root', null, 'original', '2025-12-01T00:00:00.000Z'),
    {
      type: 'context_edit',
      id: 'bad-edit',
      parentId: 'root',
      targetId: 'root',
      timestamp: 'not-a-date',
      replacement: { content: 'unknown-time correction' },
    },
    msg('child', 'bad-edit', 'child', '2026-01-21T00:00:00.000Z'),
  );
  const unknown = prepareReview([unknownSource], [], {
    requestedSince: '2026-01-15T00:00:00.000Z',
  });
  expect(texts(unknown)).toEqual(['unknown-time correction', 'child']);
  expect(unknown.warnings).toHaveLength(1);
  expect(unknown.warnings[0]).toContain('bad-edit');
  expect(unknown.incomplete).toBe(false);

  const repeated = prepareReview([unknownSource], unknown.checkpoints, {
    requestedSince: '2026-01-15T00:00:00.000Z',
  });
  expect(texts(repeated)).toEqual([]);
  expect(repeated.warnings).toHaveLength(1);
  expect(repeated.incomplete).toBe(false);
});

it('does not suppress an original version re-exposed on a fork after expansion', () => {
  const source = fixture(
    msg('root', null, 'original', '2025-09-01T00:00:00.000Z'),
    msg('checkpoint', 'root', 'checkpoint', '2025-10-20T00:00:00.000Z'),
    {
      type: 'context_edit',
      id: 'edit',
      parentId: 'checkpoint',
      targetId: 'root',
      timestamp: '2025-11-01T00:00:00.000Z',
      replacement: { content: 'edited original' },
    },
    msg('edited-child', 'edit', 'edited child', '2025-11-02T00:00:00.000Z'),
    msg('forked', 'checkpoint', 'forked branch', '2025-11-03T00:00:00.000Z'),
  );
  const expanded = prepareReview(
    [source],
    [{ ...source, entryId: 'checkpoint', since: '2025-10-01T00:00:00.000Z' }],
    { requestedSince: '2025-09-01T00:00:00.000Z' },
  );

  expect(
    expanded.evidence
      .filter((item) => item.branchId === 'forked')
      .map((item) => [item.entryId, item.editId]),
  ).toContainEqual(['root', null]);
});

it('keeps legacy NULL checkpoints unrestricted during a seed request', () => {
  const source = fixture(msg('old', null, 'old', '2020-01-01T00:00:00.000Z'));
  const review = prepareReview([source], [{ ...source, entryId: 'old', since: null }], {
    requestedSince: '2026-01-01T00:00:00.000Z',
  });
  expect(review.evidence).toEqual([]);
  expect(review.coverageChanged).toBe(true);
  expect(review.sourceDefaults).toEqual([
    { sessionId: source.sessionId, since: '2026-01-01T00:00:00.000Z' },
  ]);
});

it('freezes leaves and text, incrementally selects only later messages on a reviewed branch', () => {
  const source = fixture(msg('root', null), msg('a', 'root'));
  const first = prepareReview([source], []);
  appendFileSync(source.file, lines(msg('later', 'a')));
  expect(first.tips.map((tip) => tip.entryId)).toEqual(['a']);
  expect(texts(first)).toEqual(['root', 'a']);
  const next = prepareReview([source], first.tips);
  expect(texts(next)).toEqual(['later']);
  expect(next.evidence[0]).toMatchObject({
    branchId: 'later',
    reviewedThrough: 'a',
    cwd: '/work',
    timestamp: '2026-01-30',
  });
  expect(prepareReview([source], [...first.tips, ...next.tips]).tips).toEqual([]);
});

it('keeps alternatives separate and applies the latest branch-local edit', () => {
  const source = fixture(msg('root', null), msg('a', 'root'), msg('b', 'root'));
  const first = prepareReview([source], []);
  expect(first.evidence.map((item) => [item.branchId, item.text])).toEqual([
    ['a', 'root'],
    ['a', 'a'],
    ['b', 'root'],
    ['b', 'b'],
  ]);
  appendFileSync(
    source.file,
    lines(
      {
        type: 'context_edit',
        id: 'edit',
        parentId: 'a',
        targetId: 'root',
        replacement: { content: 'corrected' },
      },
      {
        type: 'context_edit',
        id: 'edit2',
        parentId: 'edit',
        targetId: 'root',
        replacement: { content: 'latest correction' },
      },
      msg('c', 'edit2'),
    ),
  );
  const next = prepareReview([source], first.tips);
  expect(texts(next)).toEqual(['latest correction', 'c']);
  expect(next.evidence[0]).toMatchObject({
    branchId: 'c',
    reviewedThrough: 'a',
    entryId: 'root',
    editId: 'edit2',
  });
  const whole = prepareReview([source], []);
  expect(whole.evidence.filter((item) => item.branchId === 'b').map((item) => item.text)).toEqual([
    'root',
    'b',
  ]);
});

it('omits hidden roles, non-text blocks, redacted text and summaries, retaining raw pre-compaction text', () => {
  const source = fixture(
    msg('root', null),
    {
      ...msg('assistant', 'root'),
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'visible' },
          { type: 'toolCall', name: 'bash' },
        ],
      },
    },
    { ...msg('tool', 'assistant'), message: { role: 'toolResult', content: 'hidden' } },
    { type: 'compaction', id: 'compact', parentId: 'tool', summary: 'not evidence' },
    {
      type: 'context_edit',
      id: 'redact',
      parentId: 'compact',
      targetId: 'root',
      replacement: null,
    },
  );
  expect(texts(prepareReview([source], []))).toEqual(['visible']);
});

it('repeats copied fork context without reading or deduplicating parent/sibling files', () => {
  const parent = fixture(msg('root', null), msg('a', 'root'));
  const previous = prepareReview([parent], []);
  const child = fixture(msg('root', null), msg('a', 'root'), msg('child', 'a'));
  writeFileSync(
    child.file,
    lines(
      { type: 'session', id: child.sessionId, parentSession: parent.file },
      msg('root', null),
      msg('a', 'root'),
      msg('child', 'a'),
    ),
  );
  rmSync(parent.file);
  const review = prepareReview([child], previous.tips);
  expect(texts(review)).toEqual(['root', 'a', 'child']);
  expect(review.warnings).toEqual([]);
});

it.each(['torn', 'interior', 'duplicate', 'parent', 'missing', 'identity', 'boundary'])(
  'warns and never advances unavailable %s evidence',
  (kind) => {
    const source = fixture(msg('a', null));
    const reviewed = prepareReview([source], []).tips;
    if (kind === 'torn') appendFileSync(source.file, '{"type"');
    if (kind === 'interior') appendFileSync(source.file, '{bad}\n' + lines(msg('b', 'a')));
    if (kind === 'duplicate') appendFileSync(source.file, lines(msg('a', 'a')));
    if (kind === 'parent') appendFileSync(source.file, lines(msg('b', 'unknown')));
    if (kind === 'missing') rmSync(source.file);
    if (kind === 'identity') source.sessionId = 'different';
    if (kind === 'boundary') reviewed[0]!.entryId = 'missing';
    const review = prepareReview([source], reviewed);
    expect(review.tips).toEqual([]);
    expect(review.evidence).toEqual([]);
    expect(review.warnings).toHaveLength(1);
  },
);
