import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareReview, type Source } from '../extensions/remembrancer/evidence.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const msg = (id: string, parentId: string | null, text = id) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-30',
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
