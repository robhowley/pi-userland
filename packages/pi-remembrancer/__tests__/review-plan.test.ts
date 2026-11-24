import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview, ReviewBudget, type Source } from '../extensions/remembrancer/evidence.js';
import { ReviewPlan, type PlannedRange } from '../extensions/remembrancer/review-plan.js';
import { splitsSurrogatePair, type Selected } from '../extensions/remembrancer/review-pages.js';
import type { ProposalSubmission } from '../extensions/remembrancer/proposals.js';

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
function accepted(plan: ReviewPlan, maxTextUnits = 48_000) {
  const ranges: PlannedRange[] = [];
  for (let range = plan.next(maxTextUnits); range; range = plan.next(maxTextUnits)) {
    ranges.push(range);
    plan.acceptExtraction(range);
  }
  plan.assertComplete();
  return ranges;
}

it('shares only actual ancestor versions and retains every eligible branch occurrence', () => {
  const source = fixture(
    msg('root', null, 'shared'),
    msg('a', 'root', 'identical'),
    msg('b', 'root', 'identical'),
    msg('other-root', null, 'shared'),
  );
  const review = prepareReview([source], []);
  const ranges = accepted(new ReviewPlan(review));
  expect(ranges.map((range) => range.text)).toEqual(['shared', 'identical', 'identical', 'shared']);
  expect(new Set(ranges.map((range) => range.versionId)).size).toBe(4);
  expect(ranges[0]!.occurrences.map((item) => item.branchId)).toEqual(['a', 'b']);
  const sortOccurrences = (items: object[]) =>
    items.sort((a, b) =>
      JSON.stringify(a, Object.keys(a).sort()).localeCompare(
        JSON.stringify(b, Object.keys(b).sort()),
      ),
    );
  expect(sortOccurrences(ranges.flatMap((range) => range.occurrences))).toEqual(
    sortOccurrences(
      review.evidence.map(
        ({ sessionId, branchId, entryId, editId, file, cwd, reviewedThrough, text }, order) => ({
          order,
          sessionId,
          branchId,
          entryId,
          editId,
          file,
          cwd,
          reviewedThrough,
          offset: 0,
          end: text.length,
        }),
      ),
    ),
  );
});

it('distinguishes equal-text branch edits, shares one inherited edit, and omits redactions', () => {
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
  const ranges = accepted(new ReviewPlan(prepareReview([source], [])));
  const roots = ranges.filter((range) => range.occurrences[0]!.entryId === 'root');
  expect(
    roots.map((range) => [
      range.occurrences[0]!.editId,
      range.occurrences.map((item) => item.branchId),
    ]),
  ).toEqual([
    ['edit-a', ['a1', 'a2']],
    ['edit-b', ['b']],
    [null, ['original']],
  ]);
  expect(new Set(roots.map((range) => range.versionId)).size).toBe(3);
  expect(
    ranges
      .flatMap((range) => range.occurrences)
      .filter((item) => item.branchId === 'redacted-child')
      .map((item) => item.entryId),
  ).toEqual(['redacted-child']);
});

it('reconstructs all original Unicode text at exact contiguous UTF-16 coordinates', () => {
  const text = 'a😀𐐷é\n🛠️尾'.repeat(300);
  const source = fixture(msg('root', null, text), msg('a', 'root'), msg('b', 'root'));
  const review = prepareReview([source], []);
  const ranges = accepted(new ReviewPlan(review), 7);
  for (const item of review.evidence) {
    const mapped = ranges.flatMap((range) =>
      range.occurrences
        .filter(
          (occurrence) =>
            occurrence.branchId === item.branchId && occurrence.entryId === item.entryId,
        )
        .map((occurrence) => ({ range, occurrence })),
    );
    let end = 0;
    for (const { range, occurrence } of mapped) {
      expect(occurrence.offset).toBe(end);
      expect(occurrence.end).toBe(range.end);
      expect(splitsSurrogatePair(item.text, occurrence.offset)).toBe(false);
      expect(splitsSurrogatePair(item.text, occurrence.end)).toBe(false);
      expect(item.text.slice(occurrence.offset, occurrence.end)).toBe(range.text);
      end = occurrence.end;
    }
    expect(end).toBe(item.text.length);
    expect(mapped.map(({ range }) => range.text).join('')).toBe(item.text);
  }
  expect(
    ranges
      .filter((range) => range.occurrences[0]!.entryId === 'root')
      .every((range) => range.occurrences.length === 2),
  ).toBe(true);
  expect(ranges.map((range) => range.id)).toEqual(
    accepted(new ReviewPlan(review), 7).map((range) => range.id),
  );
});

it('peeking, unaccepted final ranges, forged ranges and context cannot complete extraction', () => {
  const source = fixture(msg('root', null, 'abcdef'), msg('a', 'root'));
  const plan = new ReviewPlan(prepareReview([source], []));
  const first = plan.next(4)!;
  expect(() => plan.assertComplete()).toThrow('every original');
  const smaller = plan.next(2)!;
  expect(smaller.text).toBe('ab');
  expect(() => plan.acceptExtraction(first)).toThrow('host-issued');
  expect(() => plan.acceptExtraction({ ...smaller })).toThrow('host-issued');
  plan.acceptExtraction(smaller);
  expect(() => plan.acceptExtraction(smaller)).toThrow('host-issued');
  const rest = plan.next()!;
  expect(rest).toMatchObject({ text: 'cdef', offset: 2, end: 6 });
  plan.acceptExtraction(rest);
  const final = plan.next()!;
  plan.context('batch', final.occurrences[0]!);
  expect(() => plan.assertComplete()).toThrow('every original');
  plan.acceptExtraction(final);
  expect(plan.next()).toBeNull();
  expect(() => plan.assertComplete()).not.toThrow();
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
  const ranges = accepted(new ReviewPlan(review));
  expect(ranges.map((range) => range.text)).toEqual([
    'recent edit',
    'new',
    'unknown time',
    'sibling new',
  ]);
  expect(ranges.flatMap((range) => range.occurrences).map((item) => item.reviewedThrough)).toEqual([
    'checkpoint',
    'checkpoint',
    'checkpoint',
    'checkpoint',
  ]);
  expect(review.incomplete).toBe(false);
  expect(review.warnings).toHaveLength(1);
});

it('freezes the captured source against late appends, rewrites and caller mutation', () => {
  const source = fixture(msg('root', null), msg('selected', 'root'));
  const review = prepareReview([source], []);
  const plan = new ReviewPlan(review);
  const selected: Selected = { ...source, branchId: 'selected', entryId: 'selected', editId: null };
  appendFileSync(source.file, lines(msg('late-branch', 'root')));
  writeFileSync(source.file, 'replaced');
  review.evidence[0]!.text = 'caller mutation';
  review.snapshots[0]!.tree.entries.clear();
  expect(plan.context('batch', selected)).toMatchObject({
    contextOnly: true,
    groups: [{ entries: [{ text: 'root' }] }],
  });
  expect(accepted(plan).map((range) => range.text)).toEqual(['root', 'selected']);
});

it('pages frozen context beyond 40 entries, including text continuations, without adding coverage', () => {
  const records = Array.from({ length: 85 }, (_, i) =>
    msg(`m${i}`, i ? `m${i - 1}` : null, i === 44 ? '😀'.repeat(30_000) : `m${i}`),
  );
  const source = fixture(...records);
  const review = prepareReview([source], [{ ...source, entryId: 'm83', since: null }]);
  const plan = new ReviewPlan(review);
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
      const page = plan.context('batch', selected, { before: 40, skip, offset }) as {
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
  expect(() => plan.assertComplete()).toThrow('every original');
  expect(accepted(plan).map((range) => range.text)).toEqual(['m84']);
  expect(() => plan.context('batch', selected, { skip: 85 })).toThrow('skip');
  expect(() => plan.context('batch', selected, { before: 41 })).toThrow('before');
  expect(() => plan.context('batch', { ...selected, branchId: 'late' })).toThrow('not in');
});

it('rejects expanded session/file scope rather than deduplicating copied history', () => {
  const first = fixture(msg('same-id', null, 'same text'));
  const second = fixture(msg('same-id', null, 'same text'));
  expect(() => new ReviewPlan(prepareReview([first, second], []))).toThrow('one frozen session');
  const copied = prepareReview([second], []);
  const original = accepted(new ReviewPlan(prepareReview([first], [])))[0]!;
  expect(accepted(new ReviewPlan(copied))[0]!.versionId).not.toBe(original.versionId);
  copied.evidence[0]!.file = first.file;
  expect(() => new ReviewPlan(copied)).toThrow('one frozen session');
});

it('preserves explicit incomplete-source and resource-limit failures', () => {
  const source = fixture(msg('a', null));
  appendFileSync(source.file, '{broken}\n');
  const review = prepareReview([source], []);
  expect(review.incomplete).toBe(true);
  const current = new CaptureReview(review, () => {});
  expect(current.nextExtraction()).toBeNull();
  expect(() => current.completion([])).toThrow('incomplete');
  expect(() => new ReviewPlan(review).assertComplete()).toThrow('incomplete');
  const valid = fixture(msg('a', null), msg('b', 'a'));
  expect(() =>
    prepareReview([valid], [], undefined, [], new ReviewBudget({ totalBranchEntries: 1 })),
  ).toThrow('limit');
});

it('finishes accepted extraction against original aliases without draining legacy pages', () => {
  const source = fixture(msg('root', null, 'promise 😀'), msg('a', 'root'), msg('b', 'root'));
  const review = prepareReview([source], []);
  const current = new CaptureReview(review, () => {});
  const shared = current.nextExtraction()!;
  expect(shared.occurrences).toHaveLength(2);
  expect(() => current.completion([])).toThrow('every original');
  expect(() => current.page()).toThrow('accepted extraction');
  current.acceptExtraction(shared, ['f1']);
  for (let range = current.nextExtraction(); range; range = current.nextExtraction())
    current.acceptExtraction(range);
  const submission: ProposalSubmission = {
    change: { operation: 'add', fields: { description: 'promise' }, annotations: [] },
    expected: null,
    question: null,
    explanation: 'promise',
    references: shared.occurrences.map(({ sessionId, branchId, entryId, editId, offset }) => ({
      sessionId,
      branchId,
      entryId,
      editId,
      offset,
      quote: shared.text,
    })),
  };
  current.reconcileFinding('f1', 'r1');
  current.disposeRecord('r1', submission);
  const submissions = current.finishReconciliation();
  expect(current.completion(submissions).sources[0]).toHaveLength(2);
  expect(current.completion(submissions).plan.checkpoints).toEqual(review.checkpoints);
  expect(() =>
    current.completion([
      { ...submission, references: [{ ...submission.references[0]!, quote: 'invented' }] },
    ]),
  ).toThrow('submit exactly its dispositions');
});

it('preserves existing page callers, rejects mode mixing, and honors attempt authority', () => {
  const source = fixture(msg('a', null));
  const review = prepareReview([source], []);
  let active = true;
  const current = new CaptureReview(review, () => {
    if (!active) throw new Error('inactive');
  });
  current.page();
  expect(() => current.completion([])).not.toThrow();
  expect(() => current.nextExtraction()).toThrow('Cannot switch');
  const extraction = new CaptureReview(review, () => {
    if (!active) throw new Error('inactive');
  });
  const range = extraction.nextExtraction()!;
  expect(() =>
    extraction.extractionContext({ batch: 'wrong', selected: range.occurrences[0]! }),
  ).toThrow('matching');
  active = false;
  expect(() => extraction.acceptExtraction(range)).toThrow('inactive');
  expect(() => extraction.nextExtraction()).toThrow('inactive');
  expect(() => extraction.completion([])).toThrow('inactive');
});

it('requires acceptance even for empty findings and fails explicitly when a Unicode scalar cannot fit', () => {
  const source = fixture(msg('a', null, '😀'));
  const current = new CaptureReview(prepareReview([source], []), () => {});
  expect(() => current.nextExtraction(1)).toThrow('Unicode');
  expect(() => current.nextExtraction(0)).toThrow('positive');
  const final = current.nextExtraction(2)!;
  expect(() => current.completion([])).toThrow('every original');
  current.acceptExtraction(final);
  current.finishReconciliation();
  expect(() => current.completion([])).not.toThrow();
  const empty = new CaptureReview(prepareReview([], []), () => {});
  expect(empty.nextExtraction()).toBeNull();
  empty.finishReconciliation();
  expect(() => empty.completion([])).not.toThrow();
});
