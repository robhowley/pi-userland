import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import type { ProposalSubmission } from '../extensions/remembrancer/proposals.js';
import {
  validateCaptureSubmission,
  type CaptureSubmission,
} from '../extensions/remembrancer/capture-submission.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(text = 'I will send it') {
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
        message: { role: 'user', content: text },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const review = prepareReview([source], []);
  return { review, current: new CaptureReview(review, () => {}) };
}
function submission(quote = 'I will send it'): ProposalSubmission {
  return {
    change: { operation: 'add', fields: { description: 'send it' }, annotations: [] },
    expected: null,
    question: null,
    explanation: 'accepted',
    references: [
      { sessionId: 'session', branchId: 'entry', entryId: 'entry', editId: null, offset: 0, quote },
    ],
  };
}

it('preparing or opening every page acknowledges nothing, only accepted ordered delivery completes', () => {
  const { current } = fixture('😀'.repeat(30_000));
  const pages = [...current.preparePages()];
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) expect(page.text).not.toBe('');
  expect(() => current.completion([])).toThrow('Read all evidence');
  expect(() => pages[1]!.assertReadable()).toThrow('next evidence page');
  expect(() => pages[1]!.accept()).toThrow('next evidence page');
  pages[0]!.assertReadable();
  expect(() => current.completion([])).toThrow('Read all evidence');
  pages[0]!.accept();
  pages[0]!.accept(); // Prior rereads neither skip nor rewind the cursor.
  expect(() => current.completion([])).toThrow('Read all evidence');
  for (const page of pages.slice(1)) page.accept();
  expect(() => current.completion([])).not.toThrow();
  for (const page of pages) page.accept();
  expect(() => current.completion([])).not.toThrow();
});

it('retains exact quote validation on every publication after delivery', () => {
  const { current } = fixture();
  for (const page of current.preparePages()) page.accept();
  const valid = submission();
  const completion = current.completion([valid]);
  expect(completion.sources[0]![0]).toMatchObject(valid.references[0]!);
  expect(() => current.completion([submission('invented')])).toThrow(
    'Reference does not match frozen eligible evidence',
  );
  valid.references[0]!.offset = 1;
  expect(() => current.completion([valid])).toThrow('Reference does not match');
});

it('freezes original evidence and publication claims before preparation, including checkpoint arrays', () => {
  const { review, current } = fixture();
  const checkpoints = structuredClone(review.checkpoints);
  const successfulSources = structuredClone(review.successfulSources);
  review.evidence[0]!.text = 'changed';
  review.checkpoints.length = 0;
  review.successfulSources.length = 0;
  review.incomplete = true;
  const pages = [...current.preparePages()];
  expect(pages[0]!.text).toContain('I will send it');
  pages.forEach((page) => page.accept());
  const completion = current.completion([submission()]);
  expect(completion.plan.checkpoints).toEqual(checkpoints);
  expect(completion.plan.sources).toEqual(successfulSources);
  Reflect.set(completion.plan.checkpoints!, 'length', 0);
  expect(current.completion([]).plan.checkpoints).toEqual(checkpoints);
});

it.each(['missing', 'duplicate', 'unknown', 'merged', 'key'])(
  'requires each reported record in exactly one valid disposition (%s)',
  (defect) => {
    const { current } = fixture();
    for (const page of current.preparePages()) page.accept();
    const intent = { change: submission().change, question: null, explanation: 'Accepted' };
    const payload: CaptureSubmission = {
      records: ['f1', 'f2'].map((key) => ({
        key,
        observations: [{ kind: 'accepted', reference: submission().references[0]! }],
        states: [
          {
            branchId: 'entry',
            state: {
              summary: key,
              status: 'active',
              draft: { change: intent.change, question: null },
            },
          },
        ],
        ambiguous: false,
        candidates: [],
      })),
      dispositions: ['f1', 'f2'].map((key) => ({
        records: [key],
        reason: 'Accepted',
        submission: intent,
      })),
    };
    expect(validateCaptureSubmission(payload, current, [], [])).toHaveLength(2);
    if (defect === 'missing') payload.dispositions.pop();
    if (defect === 'duplicate') payload.dispositions[1]!.records = ['f1'];
    if (defect === 'unknown') payload.dispositions[1]!.records = ['unknown'];
    if (defect === 'merged')
      payload.dispositions = [{ ...payload.dispositions[0]!, records: ['f1', 'f2'] }];
    if (defect === 'key') payload.records[1]!.key = 'f1';
    expect(() => validateCaptureSubmission(payload, current, [], [])).toThrow();
  },
);

it('returns owned finalized submissions instead of sharing mutable reviewer declarations', () => {
  const { current } = fixture();
  for (const page of current.preparePages()) page.accept();
  const intent = { change: submission().change, question: null, explanation: 'Accepted' };
  const payload: CaptureSubmission = {
    records: [
      {
        key: 'f1',
        observations: [{ kind: 'accepted', reference: submission().references[0]! }],
        states: [
          {
            branchId: 'entry',
            state: {
              summary: 'send it',
              status: 'active',
              draft: { change: intent.change, question: null },
            },
          },
        ],
        ambiguous: false,
        candidates: [],
      },
    ],
    dispositions: [{ records: ['f1'], reason: 'Accepted', submission: intent }],
  };
  const staged = validateCaptureSubmission(payload, current, [], []);
  payload.records[0]!.observations[0]!.reference.quote = 'invented';
  intent.explanation = 'mutated';
  expect(staged[0]!.explanation).toBe('Accepted');
  expect(staged[0]!.references[0]!.quote).toBe('I will send it');
  expect(() => current.completion(staged)).not.toThrow();
});

it('keeps manual page completion tied to frozen evidence', () => {
  const { review, current } = fixture();
  review.evidence.length = 0;
  expect(() => current.completion([])).toThrow('Read all evidence');
  const page = current.page() as { groups: { entries: { text: string }[] }[] };
  expect(page.groups[0]!.entries[0]!.text).toBe('I will send it');
  expect(() => current.completion([])).not.toThrow();
});

it('allows no-work completion while an empty reviewer artifact still requires accepted delivery', () => {
  const current = new CaptureReview(prepareReview([], []), () => {});
  const pages = [...current.preparePages()];
  expect(pages).toHaveLength(1);
  expect(JSON.parse(pages[0]!.text)).toMatchObject({ groups: [], hasMore: false });
  expect(() => current.completion([])).not.toThrow();
  expect(() => current.assertEvidenceDelivered()).toThrow('Read all evidence');
  pages[0]!.accept();
  expect(() => current.assertEvidenceDelivered()).not.toThrow();
  expect(() => current.completion([submission()])).toThrow('No evidence');
});
