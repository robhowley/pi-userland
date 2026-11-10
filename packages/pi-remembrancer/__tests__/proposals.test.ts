import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CheckpointStore, type FinishPlan } from '../extensions/remembrancer/checkpoints.js';
import { beginSourceReview } from '../extensions/remembrancer/review.js';
import type { Evidence } from '../extensions/remembrancer/evidence.js';
import {
  validateDraft,
  validateSubmission,
  type ProposalSubmission,
  type TaskSnapshot,
} from '../extensions/remembrancer/proposals.js';

const evidence: Evidence = {
  file: '/a.jsonl',
  sessionId: 'session',
  branchId: 'leaf',
  entryId: 'leaf',
  editId: null,
  role: 'user',
  text: 'Send Maya the comparison tomorrow.',
  cwd: '/work',
  timestamp: '2026-01-01',
  reviewedThrough: null,
};
const submission: ProposalSubmission = {
  change: {
    operation: 'add',
    fields: { description: 'Send comparison', project: 'work', due: '20260102T000000Z' },
    annotations: ['Context: /a.jsonl (session/leaf)'],
  },
  expected: null,
  question: null,
  explanation: 'User promised the comparison.',
  references: [
    {
      sessionId: 'session',
      branchId: 'leaf',
      entryId: 'leaf',
      editId: null,
      offset: 0,
      quote: 'Send Maya',
    },
  ],
};
const plan: FinishPlan = {
  sources: [{ file: '/a.jsonl', sessionId: 'session' }],
  checkpoints: [{ file: '/a.jsonl', sessionId: 'session', entryId: 'leaf' }],
};
function freeze(store: CheckpointStore, boundary = plan, incomplete = false) {
  const token = store.claimReview();
  store.freezeReview(token, boundary, [evidence], incomplete);
  store.deliveredReview(token, { index: 1, offset: 0 });
  return token;
}
const snapshot: TaskSnapshot = {
  uuid: '00000000-0000-0000-0000-000000000001',
  status: 'pending',
  fields: { description: 'Send comparison' },
  annotations: [],
};

it('atomically persists proposals and exact frozen coverage, rolling back all rows on failure', () => {
  const store = new CheckpointStore(':memory:');
  try {
    const token = freeze(store, {
      ...plan,
      sourceDefaults: [{ sessionId: 'missing', since: '2026-01-01' }],
    });
    expect(() => store.finish(token, [submission])).toThrow(/unknown source default/);
    expect(store.proposals()).toEqual([]);
    expect(store.sources()).toEqual([]);
    expect(store.reviewed()).toEqual([]);
    store.assertReview(token);
    store.releaseReview(token);
    const boundary = structuredClone(plan);
    const next = freeze(store, boundary);
    boundary.checkpoints = [];
    const [saved] = store.finish(next, [submission]);
    expect(saved?.sources[0]).toMatchObject({
      file: '/a.jsonl',
      quote: 'Send Maya',
      role: 'user',
      timestamp: '2026-01-01',
      locator: 'session/leaf/leaf',
    });
    expect(store.reviewed()).toHaveLength(1);
    expect(() => store.assertReview(next)).toThrow();
    expect(() => store.finish(next, [submission])).toThrow();
  } finally {
    store.close();
  }
});

it('rejects stale revisions atomically and preserves edited drafts on later corrections', () => {
  const store = new CheckpointStore(':memory:');
  try {
    const [first] = store.finish(freeze(store), [submission]);
    const edited = store.editProposal(first!.id, 1, {
      change: {
        operation: 'add',
        fields: { description: 'User edited description' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    const token = freeze(store, {
      ...plan,
      checkpoints: [{ file: '/a.jsonl', sessionId: 'session', entryId: 'later' }],
    });
    expect(() =>
      store.finish(token, [submission, { ...submission, id: first!.id, expectedRevision: 1 }]),
    ).toThrow(/revision conflict/);
    expect(store.proposals()).toHaveLength(1);
    expect(store.reviewed().map((item) => item.entryId)).toEqual(['leaf']);
    const [corrected] = store.finish(token, [
      { ...submission, id: first!.id, expectedRevision: edited.revision },
    ]);
    expect(corrected!.draft!.change).toEqual(edited.draft!.change);
    expect(corrected!.draft!.question).toMatch(/conflicts/);
    expect(() => store.claimProposal(corrected!.id, corrected!.revision)).toThrow(/question/);
  } finally {
    store.close();
  }
});

it('persists drafts, decisions and claims across restart; uncertain writes cannot be retried blindly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-'));
  const path = join(dir, 'state.sqlite');
  let store = new CheckpointStore(path);
  try {
    const [first, second] = store.finish(freeze(store), [submission, submission]);
    const edited = store.editProposal(first!.id, 1, {
      change: first!.change,
      expected: null,
      question: null,
    });
    store.dismissProposal(second!.id, 1);
    const claim = store.claimProposal(edited.id, edited.revision);
    expect(() => store.claimProposal(edited.id, edited.revision)).toThrow(/revision/);
    store.close();
    store = new CheckpointStore(path);
    expect(store.proposal(claim.id)?.draft).toEqual(edited.draft);
    expect(store.proposals('dismissed')).toHaveLength(1);
    expect(store.proposals('applying')).toHaveLength(1);
    expect(() => store.editProposal(claim.id, claim.revision, edited.draft!)).toThrow(/state/);
    expect(() =>
      store.recordProposalResult(claim.id, claim.revision, 'wrong', {
        state: 'applied',
        verified: snapshot,
        error: null,
      }),
    ).toThrow(/claim/);
    const uncertain = store.recordProposalResult(claim.id, claim.revision, claim.claim!, {
      state: 'uncertain',
      verified: null,
      error: 'Write outcome unavailable',
    });
    expect(() => store.claimProposal(claim.id, uncertain.revision)).toThrow(/state/);
    const applied = store.recordProposalResult(claim.id, uncertain.revision, claim.claim!, {
      state: 'applied',
      verified: snapshot,
      error: null,
    });
    expect(store.proposals('applied')).toEqual([applied]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['edit', 'dismiss'] as const)(
  'archives failed application evidence on %s and fences the old claimant after restart',
  (action) => {
    const dir = mkdtempSync(join(tmpdir(), 'proposal-failed-'));
    const path = join(dir, 'state.sqlite');
    let store = new CheckpointStore(path);
    try {
      const [first] = store.finish(freeze(store), [submission]);
      const claim = store.claimProposal(first!.id, first!.revision, null);
      const failed = store.recordProposalResult(claim.id, claim.revision, claim.claim!, {
        state: 'failed',
        verified: snapshot,
        actual: { uuid: snapshot.uuid, description: 'Partial external write' },
        error: 'Write partially completed',
      });
      store.close();
      store = new CheckpointStore(path);
      expect(store.proposal(failed.id)).toEqual(failed);
      const decision =
        action === 'edit'
          ? store.editProposal(failed.id, failed.revision, {
              change: submission.change,
              expected: null,
              question: null,
            })
          : store.dismissProposal(failed.id, failed.revision);
      expect(decision.state).toBe(action === 'edit' ? 'pending' : 'dismissed');
      expect(decision.claim).toBeNull();
      expect(decision.result).toBeNull();
      expect(decision).not.toHaveProperty('applicationBefore');
      const { history, ...previous } = failed;
      expect(decision.history).toEqual([...history!, previous]);
      store.close();
      store = new CheckpointStore(path);
      expect(store.proposal(decision.id)).toEqual(decision);
      const result = { state: 'applied' as const, verified: snapshot, error: null };
      expect(() =>
        store.recordProposalResult(decision.id, claim.revision, claim.claim!, result),
      ).toThrow(/revision/);
      expect(() =>
        store.recordProposalResult(decision.id, decision.revision, claim.claim!, result),
      ).toThrow(/state/);
      if (action === 'edit') {
        const next = store.claimProposal(decision.id, decision.revision);
        expect(next.claim).not.toBe(claim.claim);
        expect(() =>
          store.recordProposalResult(next.id, next.revision, claim.claim!, result),
        ).toThrow(/claim/);
        expect(store.proposal(next.id)).toEqual(next);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(['applied', 'already_satisfied', 'failed', 'uncertain'] as const)(
  'persists matching %s outcome and claim, rejecting invalid outcomes without mutation',
  (state) => {
    const dir = mkdtempSync(join(tmpdir(), 'proposal-result-'));
    const path = join(dir, 'state.sqlite');
    let store = new CheckpointStore(path);
    try {
      const [first] = store.finish(freeze(store), [submission]);
      const claim = store.claimProposal(first!.id, first!.revision, null);
      for (const invalid of [
        { state: 'pending', verified: null, error: null },
        { state: 'applied', verified: null, error: null },
        { state: 'failed', verified: null, error: '' },
      ]) {
        expect(() =>
          store.recordProposalResult(claim.id, claim.revision, claim.claim!, invalid as never),
        ).toThrow();
        expect(store.proposal(claim.id)).toEqual(claim);
      }
      const result =
        state === 'applied' || state === 'already_satisfied'
          ? { state, verified: snapshot, error: null }
          : { state, verified: snapshot, error: 'Partial write' };
      const saved = store.recordProposalResult(claim.id, claim.revision, claim.claim!, result);
      store.close();
      store = new CheckpointStore(path);
      expect(store.proposal(saved.id)).toEqual(saved);
      expect(saved).toMatchObject({ state, claim: claim.claim, result, applicationBefore: null });
      expect(() => store.claimProposal(saved.id, saved.revision)).toThrow(/state/);
      if (state === 'uncertain') {
        expect(() => store.dismissProposal(saved.id, saved.revision)).toThrow(/state/);
        expect(() =>
          store.editProposal(saved.id, saved.revision, {
            change: submission.change,
            expected: null,
            question: null,
          }),
        ).toThrow(/state/);
        const resolved = store.recordProposalResult(saved.id, saved.revision, claim.claim!, {
          state: 'already_satisfied',
          verified: snapshot,
          error: null,
        });
        store.close();
        store = new CheckpointStore(path);
        expect(store.proposal(saved.id)).toEqual(resolved);
        expect(resolved.history?.at(-1)?.result).toEqual(result);
      } else {
        expect(() =>
          store.recordProposalResult(saved.id, saved.revision, claim.claim!, result),
        ).toThrow(/state/);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('rejects arbitrary locators, wrong branches, edits, offsets, quotes and unsupported task fields', () => {
  for (const patch of [
    { branchId: 'other' },
    { editId: 'later-edit' },
    { entryId: 'other' },
    { sessionId: 'other' },
    { offset: 1 },
    { quote: 'invented' },
    { file: '/invented' },
  ]) {
    expect(() =>
      validateSubmission(
        { ...submission, references: [{ ...submission.references[0]!, ...patch }] },
        [evidence],
      ),
    ).toThrow();
  }
  expect(() => validateSubmission(submission, [])).toThrow(/eligible evidence/);
  expect(() =>
    validateDraft({
      change: { operation: 'update', targetUuid: snapshot.uuid, fields: {}, annotations: [] },
      expected: null,
      question: null,
    }),
  ).toThrow(/snapshot/);
  expect(() =>
    validateDraft({
      change: {
        operation: 'add',
        fields: { description: 'a', status: 'completed' } as never,
        annotations: [],
      },
      expected: null,
      question: null,
    }),
  ).toThrow(/fields/);
});

it('requires complete delivered continuations and refuses incomplete source scopes', () => {
  const store = new CheckpointStore(':memory:');
  try {
    const token = store.claimReview();
    store.freezeReview(token, plan, [evidence], false);
    expect(() => store.finish(token, [])).toThrow(/all evidence/);
    store.deliveredReview(token, { index: 0, offset: 5 });
    expect(() => store.finish(token, [])).toThrow(/all evidence/);
    store.deliveredReview(token, { index: 1, offset: 0 });
    expect(store.finish(token, [])).toEqual([]);
    const incomplete = freeze(store, plan, true);
    expect(() => store.finish(incomplete, [])).toThrow(/incomplete/);
  } finally {
    store.close();
  }
});

it('shares session-only paging without archive discovery and leaves later evidence eligible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-review-'));
  const file = join(dir, 'session.jsonl');
  const store = new CheckpointStore(':memory:');
  const message = (id: string, parentId: string | null, text: string) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: text },
  });
  writeFileSync(
    file,
    [{ type: 'session', id: 'session', cwd: dir }, message('old', null, 'x'.repeat(14000))]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  try {
    const review = beginSourceReview(store, [{ file, sessionId: 'session' }]);
    expect(review.page()['hasMore']).toBe(true);
    expect(() => review.finish([])).toThrow(/all evidence/);
    appendFileSync(file, JSON.stringify(message('new', 'old', 'Late promise')) + '\n');
    expect(review.page()['hasMore']).toBe(false);
    review.finish([]);
    const next = beginSourceReview(store, [{ file, sessionId: 'session' }]);
    expect(next.batch.evidence.map((item) => item.entryId)).toEqual(['new']);
    next.cancel();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
