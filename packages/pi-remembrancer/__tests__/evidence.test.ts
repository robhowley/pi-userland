import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  branchEvidence,
  prepareReview,
  readSession,
  resolveSeedSince,
  ReviewBudget,
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

it('processes same-path identities independently while charging the path once', () => {
  const source = fixture(msg('message', null, 'evidence'));
  const conflicting = { ...source, sessionId: 'different-session' };

  const review = prepareReview(
    [source, conflicting],
    [],
    undefined,
    [],
    new ReviewBudget({ sources: 1 }),
  );

  expect(texts(review)).toEqual(['evidence']);
  expect(review.successfulSources).toEqual([{ ...source, seedSince: null }]);
  expect(review.incomplete).toBe(true);
  expect(review.warnings).toHaveLength(1);
  expect(review.warnings[0]).toContain('Session header ID changed');
});

it('deduplicates exact source references without consuming another source slot', () => {
  const source = fixture(msg('message', null, 'evidence'));

  const review = prepareReview(
    [source, { ...source }],
    [],
    undefined,
    [],
    new ReviewBudget({ sources: 1 }),
  );

  expect(texts(review)).toEqual(['evidence']);
  expect(review.successfulSources).toEqual([{ ...source, seedSince: null }]);
  expect(review.incomplete).toBe(false);
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
  expect(
    expanded.evidence
      .filter((item) => item.branchId === 'edited-child')
      .map((item) => [item.entryId, item.editId, item.text]),
  ).toContainEqual(['root', 'edit', 'edited original']);
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
  const original = readFileSync(source.file, 'utf8');
  const first = prepareReview([source], []);
  const frozenEvidence = first.evidence.map((item) => ({ ...item }));
  writeFileSync(source.file, 'rewritten after begin');
  rmSync(source.file);
  expect(first.tips.map((tip) => tip.entryId)).toEqual(['a']);
  expect(first.evidence).toEqual(frozenEvidence);
  expect(texts(first)).toEqual(['root', 'a']);
  writeFileSync(source.file, original);
  appendFileSync(source.file, lines(msg('later', 'a')));
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

it('projects compact review fields while preserving topology and branch-visible output', () => {
  const source = fixture(
    {
      type: 'message',
      id: 'root',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'root 😀' },
          { type: 'thinking', thinking: 'drop root thinking' },
          { type: 'image', data: 'drop root image' },
          { type: 'text', text: 'tail é' },
        ],
        usage: { input: 999_999 },
      },
    },
    {
      type: 'message',
      id: 'empty',
      parentId: 'root',
      timestamp: '2026-01-02T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'thinking', thinking: 'drop empty thinking' },
          { type: 'image', data: 'drop empty image' },
        ],
      },
    },
    {
      type: 'message',
      id: 'tool',
      parentId: 'empty',
      timestamp: '2026-01-03T00:00:00.000Z',
      message: {
        role: 'toolResult',
        content: [
          { type: 'text', text: 'drop tool output' },
          { type: 'image', data: 'drop tool image' },
        ],
        toolCallId: 'drop tool call',
      },
    },
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'tool',
      timestamp: '2026-01-04T00:00:00.000Z',
      summary: 'drop summary',
      details: { hidden: 'drop compaction details' },
    },
    {
      type: 'message',
      id: 'assistant',
      parentId: 'compact',
      timestamp: '2026-01-05T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'drop assistant thinking' },
          { type: 'text', text: 'visible ✅' },
          { type: 'image', data: 'drop assistant image' },
          { type: 'text', text: 'second' },
        ],
        provider: 'drop provider',
      },
    },
    {
      type: 'message',
      id: 'fork-a',
      parentId: 'assistant',
      timestamp: '2026-01-06T00:00:00.000Z',
      message: { role: 'user', content: 'fork A' },
    },
    {
      type: 'context_edit',
      id: 'edit-a-old',
      parentId: 'fork-a',
      targetId: 'root',
      timestamp: '2026-01-07T00:00:00.000Z',
      replacement: { content: [{ type: 'text', text: 'first correction' }] },
    },
    {
      type: 'context_edit',
      id: 'edit-a-latest',
      parentId: 'edit-a-old',
      targetId: 'root',
      timestamp: '2026-01-08T00:00:00.000Z',
      replacement: {
        content: [
          { type: 'text', text: 'edited root 🛠️' },
          { type: 'thinking', thinking: 'drop edit thinking' },
          { type: 'text', text: 'tail' },
        ],
        details: { hidden: 'drop edit details' },
      },
    },
    {
      type: 'message',
      id: 'a-child',
      parentId: 'edit-a-latest',
      timestamp: '2026-01-09T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'A 𐐷' },
          { type: 'text', text: 'second' },
        ],
      },
    },
    {
      type: 'message',
      id: 'fork-b',
      parentId: 'assistant',
      timestamp: '2026-01-06T01:00:00.000Z',
      message: { role: 'assistant', content: 'fork B' },
    },
    {
      type: 'context_edit',
      id: 'redact-b',
      parentId: 'fork-b',
      targetId: 'assistant',
      timestamp: '2026-01-07T01:00:00.000Z',
      replacement: null,
      details: { hidden: 'drop redaction details' },
    },
    {
      type: 'message',
      id: 'b-child',
      parentId: 'redact-b',
      timestamp: '2026-01-09T01:00:00.000Z',
      message: { role: 'user', content: 'B child' },
    },
  );
  const tree = readSession(source.file);
  const entries = tree.entries;

  expect([...entries.keys()]).toEqual([
    'root',
    'empty',
    'tool',
    'compact',
    'assistant',
    'fork-a',
    'edit-a-old',
    'edit-a-latest',
    'a-child',
    'fork-b',
    'redact-b',
    'b-child',
  ]);
  expect(tree.tips.map((tip) => tip.entryId)).toEqual(['a-child', 'b-child']);
  expect(entries.get('root')).toEqual({
    id: 'root',
    parentId: null,
    type: 'message',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'root 😀\ntail é' },
  });
  expect(entries.get('empty')).toEqual({
    id: 'empty',
    parentId: 'root',
    type: 'message',
    timestamp: '2026-01-02T00:00:00.000Z',
    message: { role: 'user', content: '' },
  });
  expect(entries.get('assistant')).toEqual({
    id: 'assistant',
    parentId: 'compact',
    type: 'message',
    timestamp: '2026-01-05T00:00:00.000Z',
    message: { role: 'assistant', content: 'visible ✅\nsecond' },
  });
  expect(entries.get('edit-a-latest')).toEqual({
    id: 'edit-a-latest',
    parentId: 'edit-a-old',
    type: 'context_edit',
    timestamp: '2026-01-08T00:00:00.000Z',
    targetId: 'root',
    replacement: { content: 'edited root 🛠️\ntail' },
  });
  expect(entries.get('redact-b')).toEqual({
    id: 'redact-b',
    parentId: 'fork-b',
    type: 'context_edit',
    timestamp: '2026-01-07T01:00:00.000Z',
    targetId: 'assistant',
    replacement: null,
  });
  expect(entries.get('tool')).not.toHaveProperty('message');
  expect(entries.get('compact')).not.toHaveProperty('summary');
  expect(entries.get('compact')).not.toHaveProperty('details');
  for (const entry of entries.values()) {
    expect(entry).not.toHaveProperty('usage');
    expect(entry).not.toHaveProperty('provider');
    expect(entry).not.toHaveProperty('thinking');
    expect(entry).not.toHaveProperty('image');
  }
  const compactEntries = JSON.stringify([...entries.values()]);
  for (const discarded of [
    'drop root thinking',
    'drop root image',
    'drop empty thinking',
    'drop empty image',
    'drop tool output',
    'drop tool image',
    'drop tool call',
    'drop summary',
    'drop assistant thinking',
    'drop assistant image',
    'drop provider',
    'drop edit thinking',
    'drop edit details',
    'drop redaction details',
  ])
    expect(compactEntries).not.toContain(discarded);

  const branchShape = (tip: string) =>
    branchEvidence(tree, { ...source, entryId: tip }).map((item) => [
      item.entryId,
      item.role,
      item.text,
      item.editId,
    ]);
  expect(branchShape('a-child')).toEqual([
    ['root', 'user', 'edited root 🛠️\ntail', 'edit-a-latest'],
    ['assistant', 'assistant', 'visible ✅\nsecond', null],
    ['fork-a', 'user', 'fork A', null],
    ['a-child', 'assistant', 'A 𐐷\nsecond', null],
  ]);
  expect(branchShape('b-child')).toEqual([
    ['root', 'user', 'root 😀\ntail é', null],
    ['fork-b', 'assistant', 'fork B', null],
    ['b-child', 'user', 'B child', null],
  ]);
  expect(texts(prepareReview([source], [], undefined, [{ source, tree }]))).toEqual([
    'edited root 🛠️\ntail',
    'visible ✅\nsecond',
    'fork A',
    'A 𐐷\nsecond',
    'root 😀\ntail é',
    'fork B',
    'B child',
  ]);
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
