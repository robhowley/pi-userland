import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import type { ProposalSubmission } from '../extensions/remembrancer/proposals.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'capture-review-ledger-'));
  dirs.push(dir);
  const source = { file: join(dir, 'session.jsonl'), sessionId: 'session' };
  writeFileSync(
    source.file,
    [
      { type: 'session', id: 'session', cwd: '/work' },
      {
        type: 'message',
        id: 'entry',
        parentId: null,
        timestamp: '2026-01-30',
        message: { role: 'user', content: 'I will send it' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const review = prepareReview([source], []);
  return { review, current: new CaptureReview(review, () => {}) };
}
function extracted(ids = ['f1', 'f2']) {
  const { review, current } = fixture();
  const range = current.nextExtraction()!;
  current.acceptExtraction(range, ids);
  expect(current.nextExtraction()).toBeNull();
  const submission: ProposalSubmission = {
    change: { operation: 'add', fields: { description: 'send it' }, annotations: [] },
    expected: null,
    question: null,
    explanation: 'accepted',
    references: range.occurrences.map(({ sessionId, branchId, entryId, editId, offset }) => ({
      sessionId,
      branchId,
      entryId,
      editId,
      offset,
      quote: range.text,
    })),
  };
  return { review, current, submission };
}

it.each([null, 'proposal'])(
  'rejects membership changes after disposition without losing the unassigned finding (%s)',
  (kind) => {
    const { current, submission } = extracted();
    current.reconcileFinding('f1', 'r1');
    current.disposeRecord('r1', kind === null ? null : submission);
    expect(() => current.reconcileFinding('f2', 'r1')).toThrow('disposed');
    expect(() => current.finishReconciliation()).toThrow('every capture finding');
    current.reconcileFinding('f2', 'r2');
    current.disposeRecord('r2', null);
    const staged = current.finishReconciliation();
    expect(staged).toEqual(kind === null ? [] : [submission]);
    expect(() => current.completion(staged)).not.toThrow();
  },
);

it('merges membership before disposition and closes every mutation after sealing', () => {
  const { current, submission } = extracted();
  current.reconcileFinding('f1', 'r1');
  current.reconcileFinding('f2', 'r2');
  current.mergeRecords('r1', ['r2']);
  expect(() => current.disposeRecord('r2', null)).toThrow('Unknown');
  current.disposeRecord('r1', submission);
  expect(() => current.mergeRecords('r1', [])).toThrow('disposed');
  expect(() => current.disposeRecord('r1', null)).toThrow('disposed');
  const staged = current.finishReconciliation();
  expect(staged).toEqual([submission]);
  expect(() => current.reconcileFinding('f1', 'r3')).toThrow();
  expect(() => current.mergeRecords('r1', [])).toThrow();
  staged[0]!.explanation = 'mutated';
  expect(current.finishReconciliation()).toEqual([submission]);
  expect(() => current.completion(staged)).toThrow('exactly its dispositions');
  expect(() => current.completion([submission])).not.toThrow();
});

it('retains publication-time quote validation even for an exactly sealed invalid submission', () => {
  const { current, submission } = extracted(['f1']);
  submission.references[0]!.quote = 'invented';
  current.reconcileFinding('f1', 'r1');
  current.disposeRecord('r1', submission);
  const staged = current.finishReconciliation();
  expect(() => current.completion(staged)).toThrow(
    'Reference does not match frozen eligible evidence',
  );
});

it('freezes original publication claims before extraction, including caller-owned checkpoint arrays', () => {
  const { review, current } = extracted(['f1']);
  const checkpoints = structuredClone(review.checkpoints);
  const successfulSources = structuredClone(review.successfulSources);
  review.evidence[0]!.text = 'changed';
  review.checkpoints.length = 0;
  review.successfulSources.length = 0;
  current.reconcileFinding('f1', 'r1');
  current.disposeRecord('r1', null);
  current.finishReconciliation();
  const completion = current.completion([]);
  expect(completion.plan.checkpoints).toEqual(checkpoints);
  expect(completion.plan.sources).toEqual(successfulSources);
});

it('keeps manual page completion tied to frozen evidence and validates each publication', () => {
  const { review, current } = fixture();
  const evidence = structuredClone(review.evidence);
  review.evidence.length = 0;
  review.incomplete = true;
  expect(() => current.completion([])).toThrow('Read all evidence');
  const page = current.page() as { groups: { entries: { text: string }[] }[] };
  expect(page.groups[0]!.entries[0]!.text).toBe(evidence[0]!.text);
  expect(() => current.completion([])).not.toThrow();
});
