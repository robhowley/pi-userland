import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview, ReviewBudget, type Source } from '../extensions/remembrancer/evidence.js';
import {
  splitsSurrogatePair,
  type EvidencePageEntry,
  type Selected,
} from '../extensions/remembrancer/review-pages.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const msg = (id: string, parentId: string | null, text = id, timestamp = '2026-01-30') => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: { role: 'user', content: text },
});
const edit = (id: string, parentId: string, targetId: string, text: string | null) => ({
  type: 'context_edit',
  id,
  parentId,
  targetId,
  timestamp: '2026-01-30',
  replacement: text === null ? null : { content: text },
});
const lines = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';
function fixture(...records: unknown[]): Source {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-review-plan-'));
  dirs.push(dir);
  const source = { file: join(dir, 'session.jsonl'), sessionId: dir };
  writeFileSync(
    source.file,
    lines({ type: 'session', id: source.sessionId, cwd: '/work' }, ...records),
  );
  return source;
}
function entries(current: CaptureReview): EvidencePageEntry[] {
  return [...current.preparePages()].flatMap((page) => {
    const data = JSON.parse(page.text);
    return data.groups.flatMap(({ entries, ...group }: { entries: object[] }) =>
      entries.map((entry) => ({ ...group, ...entry })),
    );
  });
}
function delivered(current: CaptureReview) {
  for (const page of current.preparePages()) page.accept();
}

it('preserves branch grouping and original evidence order rather than collapsing shared ancestors', () => {
  const source = fixture(
    msg('root', null, 'shared'),
    msg('a', 'root', 'identical'),
    msg('b', 'root', 'identical'),
    msg('other-root', null, 'shared'),
  );
  const review = prepareReview([source], []);
  const current = new CaptureReview(review, () => {});
  const actual = entries(current);
  expect(
    actual.map(({ branchId, entryId, editId, text, offset }) => ({
      branchId,
      entryId,
      editId,
      text,
      offset,
    })),
  ).toEqual(
    review.evidence.map(({ branchId, entryId, editId, text }) => ({
      branchId,
      entryId,
      editId,
      text,
      offset: 0,
    })),
  );
  expect(actual.filter((entry) => entry.entryId === 'root').map((entry) => entry.branchId)).toEqual(
    ['a', 'b'],
  );
  expect(() => current.completion([])).toThrow('Read all evidence');
  delivered(current);
  expect(current.completion([]).plan.checkpoints).toEqual(review.checkpoints);
});

it('never timestamp-sorts a branch whose child predates its parent', () => {
  const source = fixture(
    msg('root', null, 'accepted commitment', '2026-01-31'),
    msg('correction', 'root', 'corrected commitment', '2026-01-01'),
  );
  const current = new CaptureReview(prepareReview([source], []), () => {});
  expect(entries(current).map((entry) => entry.entryId)).toEqual(['root', 'correction']);
});

it('distinguishes equal-text branch edits, keeps inherited edits, and omits redactions', () => {
  const source = fixture(
    msg('root', null, 'same'),
    edit('edit-a', 'root', 'root', 'same'),
    msg('a1', 'edit-a'),
    msg('a2', 'edit-a'),
    edit('edit-b', 'root', 'root', 'same'),
    msg('b', 'edit-b'),
    msg('original', 'root'),
    edit('redact', 'root', 'root', null),
    msg('redacted-child', 'redact'),
  );
  const actual = entries(new CaptureReview(prepareReview([source], []), () => {}));
  expect(
    actual
      .filter((entry) => entry.entryId === 'root')
      .map((entry) => [entry.editId, entry.branchId]),
  ).toEqual([
    ['edit-a', 'a1'],
    ['edit-a', 'a2'],
    ['edit-b', 'b'],
    [null, 'original'],
  ]);
  expect(
    actual.filter((entry) => entry.branchId === 'redacted-child').map((entry) => entry.entryId),
  ).toEqual(['redacted-child']);
});

it('reconstructs Unicode continuations at exact absolute UTF-16 coordinates for every branch', () => {
  const text = 'a😀𐐷é\n🛠️尾'.repeat(5000);
  const source = fixture(msg('root', null, text), msg('a', 'root'), msg('b', 'root'));
  const review = prepareReview([source], []);
  const current = new CaptureReview(review, () => {});
  const actual = entries(current);
  for (const item of review.evidence) {
    const fragments = actual.filter(
      (entry) => entry.branchId === item.branchId && entry.entryId === item.entryId,
    );
    let offset = 0;
    for (const fragment of fragments) {
      expect(fragment.offset).toBe(offset);
      expect(splitsSurrogatePair(item.text, offset)).toBe(false);
      offset += fragment.text.length;
      expect(splitsSurrogatePair(item.text, offset)).toBe(false);
      expect(item.text.slice(fragment.offset, offset)).toBe(fragment.text);
    }
    expect(offset).toBe(item.text.length);
    expect(fragments.map((entry) => entry.text).join('')).toBe(item.text);
  }
  expect(actual.length).toBeGreaterThan(review.evidence.length);
  for (const page of current.preparePages())
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(51_200);
});

it('keeps checkpoint, cutoff, effective-edit and unknown-time eligibility unchanged', () => {
  const source = fixture(
    msg('old', null, 'old', '2025-01-01'),
    msg('checkpoint', 'old', 'covered', '2026-01-20'),
    msg('a', 'checkpoint', 'new'),
    edit('new-edit', 'a', 'old', 'recent edit'),
    msg('unknown', 'new-edit', 'unknown time', 'invalid'),
    msg('b', 'checkpoint', 'sibling new'),
  );
  const review = prepareReview(
    [source],
    [{ ...source, entryId: 'checkpoint', since: '2026-01-15' }],
  );
  expect(entries(new CaptureReview(review, () => {})).map((entry) => entry.text)).toEqual([
    'recent edit',
    'new',
    'unknown time',
    'sibling new',
  ]);
  expect(review.incomplete).toBe(false);
  expect(review.warnings).toHaveLength(1);
});

it('freezes source evidence and context against late appends, rewrites and caller mutation', () => {
  const source = fixture(msg('root', null), msg('selected', 'root'));
  const review = prepareReview([source], []);
  const current = new CaptureReview(review, () => {});
  const selected: Selected = { ...source, branchId: 'selected', entryId: 'selected', editId: null };
  appendFileSync(source.file, lines(msg('late-branch', 'root')));
  writeFileSync(source.file, 'replaced');
  review.evidence[0]!.text = 'caller mutation';
  review.snapshots[0]!.tree.entries.clear();
  expect(current.context({ batch: current.id, selected })).toMatchObject({
    contextOnly: true,
    groups: [{ entries: [{ text: 'root' }] }],
  });
  expect(entries(current).map((entry) => entry.text)).toEqual(['root', 'selected']);
});

it('pages frozen context beyond 40 entries, including Unicode continuations, without coverage', () => {
  const records = Array.from({ length: 85 }, (_, i) =>
    msg(`m${i}`, i ? `m${i - 1}` : null, i === 44 ? '😀'.repeat(30_000) : `m${i}`),
  );
  const source = fixture(...records);
  const review = prepareReview([source], [{ ...source, entryId: 'm83', since: null }]);
  const current = new CaptureReview(review, () => {});
  const selected: Selected = {
    sessionId: source.sessionId,
    branchId: 'm84',
    entryId: 'm84',
    editId: null,
  };
  const seen: { entryId: string; text: string }[] = [];
  let skip: number | null = 0;
  while (skip !== null) {
    let offset: number | null = 0;
    let nextSkip: number | null = null;
    while (offset !== null) {
      const page = current.context({ batch: current.id, selected, before: 40, skip, offset }) as {
        contextOnly: boolean;
        nextOffset: number | null;
        nextSkip: number | null;
        groups: { entries: { entryId: string; text: string }[] }[];
      };
      expect(page.contextOnly).toBe(true);
      seen.push(...page.groups.flatMap((group) => group.entries));
      offset = page.nextOffset;
      nextSkip = page.nextSkip;
    }
    skip = nextSkip;
  }
  expect(new Set(seen.map((item) => item.entryId)).size).toBe(84);
  expect(
    seen
      .filter((item) => item.entryId === 'm44')
      .map((item) => item.text)
      .join(''),
  ).toBe('😀'.repeat(30_000));
  expect(() => current.completion([])).toThrow('Read all evidence');
  expect(entries(current).map((entry) => entry.text)).toEqual(['m84']);
  expect(() => current.context({ batch: current.id, selected, skip: 85 })).toThrow('skip');
  expect(() => current.context({ batch: current.id, selected, before: 41 })).toThrow('before');
  expect(() =>
    current.context({ batch: current.id, selected: { ...selected, branchId: 'late' } }),
  ).toThrow('not in');
});

it('rejects expanded session/file scope rather than deduplicating copied history', () => {
  const first = fixture(msg('same-id', null, 'same text'));
  const second = fixture(msg('same-id', null, 'same text'));
  expect(() => new CaptureReview(prepareReview([first, second], []), () => {})).toThrow(
    'one frozen session',
  );
  const copied = prepareReview([second], []);
  copied.evidence[0]!.file = first.file;
  expect(() => new CaptureReview(copied, () => {})).toThrow('one frozen session');
});

it('preserves incomplete-source and resource-limit failures', () => {
  const source = fixture(msg('a', null));
  appendFileSync(source.file, '{broken}\n');
  const review = prepareReview([source], []);
  expect(review.incomplete).toBe(true);
  const current = new CaptureReview(review, () => {});
  delivered(current);
  expect(() => current.completion([])).toThrow('incomplete');
  const valid = fixture(msg('a', null), msg('b', 'a'));
  expect(() =>
    prepareReview([valid], [], undefined, [], new ReviewBudget({ totalBranchEntries: 1 })),
  ).toThrow('limit');
});

it('checks attempt authority when preparing, opening, acknowledging and completing', () => {
  const source = fixture(msg('a', null));
  let active = true;
  const current = new CaptureReview(prepareReview([source], []), () => {
    if (!active) throw new Error('inactive');
  });
  const page = [...current.preparePages()][0]!;
  active = false;
  expect(() => [...current.preparePages()]).toThrow('inactive');
  expect(() => page.assertReadable()).toThrow('inactive');
  expect(() => page.accept()).toThrow('inactive');
  expect(() => current.completion([])).toThrow('inactive');
});
