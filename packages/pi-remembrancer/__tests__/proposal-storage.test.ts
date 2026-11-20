import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import type { Evidence } from '../extensions/remembrancer/evidence.js';
import {
  unionProposalSources,
  validateSubmission,
  type Proposal,
  type ProposalDraft,
  type ProposalSource,
  type ProposalSubmission,
} from '../extensions/remembrancer/proposals.js';
import { captureJob } from './fixtures/capture-job.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const reference = {
  sessionId: 'session',
  branchId: 'leaf',
  entryId: 'leaf',
  editId: null,
  offset: 0,
  quote: 'promise',
};
const evidence: Evidence = {
  ...reference,
  file: '/synthetic/session.jsonl',
  role: 'user',
  timestamp: '2026-01-01',
  text: 'promise promise',
  cwd: '/synthetic',
  reviewedThrough: null,
};
const submission: ProposalSubmission = {
  change: { operation: 'add', fields: { description: 'Keep promise' }, annotations: [] },
  expected: null,
  question: null,
  explanation: 'A promise',
  references: [reference],
};
const source: ProposalSource = validateSubmission(submission, [evidence])[0]!;
const proposal: Proposal = {
  id: 'saved',
  revision: 7,
  change: submission.change,
  expected: null,
  question: null,
  explanation: submission.explanation,
  draft: null,
  sources: [source],
  state: 'pending',
  claim: null,
  result: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-storage-'));
  dirs.push(dir);
  const path = join(dir, 'index.sqlite');
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'leaf',
        parentId: null,
        timestamp: '2026-01-01',
        message: { role: 'user', content: evidence.text },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  const store = new CheckpointStore(path);
  const sql = new DatabaseSync(path);
  return { path, file, store, sql };
}
function insert(sql: DatabaseSync, value: Proposal) {
  sql
    .prepare('INSERT INTO proposals VALUES (?, ?, ?, ?)')
    .run(value.id, value.revision, value.state, JSON.stringify(value));
}
function raw(sql: DatabaseSync, id = proposal.id) {
  return sql.prepare('SELECT revision, state, body FROM proposals WHERE id = ?').get(id);
}

it('validates all 100 references before retaining one first-seen source', () => {
  const references = Array.from({ length: 100 }, () => ({ ...reference }));
  expect(validateSubmission({ ...submission, references }, [evidence])).toEqual([source]);
  expect(() =>
    validateSubmission(
      { ...submission, references: [...references, { ...reference, file: '/invented' } as never] },
      [evidence],
    ),
  ).toThrow('Invalid proposal fields');
  expect(() =>
    validateSubmission(
      { ...submission, references: [...references, { ...reference, offset: 1 }] },
      [evidence],
    ),
  ).toThrow('Reference does not match');
});

it('persists 100 submitted references as one source', () => {
  const f = fixture();
  const owner = f.store.claimCaptureWorker();
  try {
    const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
    capture.review.page();
    const [saved] = f.store.finishCaptureJob(owner, capture.attempt, [
      { ...submission, references: Array.from({ length: 100 }, () => ({ ...reference })) },
    ]);
    expect(JSON.parse(raw(f.sql, saved!.id)!['body'] as string).sources).toEqual([
      { ...source, file: f.file },
    ]);
    expect(saved!.revision).toBe(1);
  } finally {
    owner.release();
    f.sql.close();
    f.store.close();
  }
});

it('uses all six identity components, keeps order and first-seen metadata, and avoids tuple collisions', () => {
  const distinct = [
    source,
    { ...source, sessionId: 'other' },
    { ...source, branchId: 'other' },
    { ...source, entryId: 'other' },
    { ...source, editId: 'edit' },
    { ...source, offset: 8 },
    { ...source, quote: 'promise promise' },
    { ...source, sessionId: 'a/b', branchId: 'c' },
    { ...source, sessionId: 'a', branchId: 'b/c' },
    { ...source, editId: 'null' },
  ];
  const duplicate = {
    ...source,
    file: '/moved',
    role: 'assistant' as const,
    timestamp: 'later',
    locator: 'different',
  };
  expect(unionProposalSources(distinct, [duplicate, ...distinct].reverse())).toEqual(distinct);
  expect(unionProposalSources([duplicate], [source])).toEqual([duplicate]);
  const eligible = [
    evidence,
    ...distinct
      .slice(1)
      .filter((item) => item.offset === 0 && item.quote === 'promise')
      .map((item) => ({ ...evidence, ...item })),
  ];
  const references = distinct.map(({ sessionId, branchId, entryId, editId, offset, quote }) => ({
    sessionId,
    branchId,
    entryId,
    editId,
    offset,
    quote,
  }));
  expect(validateSubmission({ ...submission, references }, eligible)).toHaveLength(distinct.length);
});

it.each(['pending', 'edited', 'conflict-marked'] as const)(
  'keeps raw bytes, revision, timestamps and notices through 100 identical %s capture saves',
  (kind) => {
    const f = fixture();
    const conflict = 'New evidence conflicts with an edited draft. Review both before applying.';
    const draft: ProposalDraft = {
      change: {
        operation: 'add',
        fields: { description: 'Edited promise' },
        annotations: [],
      },
      expected: null,
      question: kind === 'conflict-marked' ? conflict : null,
    };
    const initial: Proposal = {
      ...proposal,
      sources: [{ ...source, file: f.file }],
      draft:
        kind === 'pending'
          ? null
          : { change: draft.change, expected: draft.expected, question: draft.question },
    };
    insert(f.sql, initial);
    const before = raw(f.sql);
    const notice = f.store.proposalNotice();
    const owner = f.store.claimCaptureWorker();
    try {
      // Re-expose this synthetic accepted passage before each attempt. Production
      // coverage is still written and checked through the public completion path.
      for (let index = 0; index < 100; index++) {
        f.sql.exec('DELETE FROM reviewed_boundaries');
        const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
        capture.review.page();
        const [saved] = f.store.finishCaptureJob(owner, capture.attempt, [
          {
            ...submission,
            id: initial.id,
            expectedRevision: initial.revision,
            references: Array.from({ length: 100 }, () => ({ ...reference })),
          },
        ]);
        expect(saved).toEqual(initial);
        expect(raw(f.sql)).toEqual(before);
        expect(f.store.proposalNotice()).toEqual(notice);
        expect(f.store.captureJob(capture.manifest.id)?.state).toBe('completed');
        expect(f.store.reviewed()).toHaveLength(1);
      }
      expect(() => f.store.editProposal(initial.id, initial.revision - 1, draft)).toThrow(
        'revision',
      );
    } finally {
      owner.release();
      f.sql.close();
      f.store.close();
    }
  },
);

it.each(['revision', 'sql-revision', 'state', 'repeated', 'context'] as const)(
  'checks %s before accepting an identical capture save',
  (blocker) => {
    const f = fixture();
    const initial: Proposal = {
      ...proposal,
      sources: [{ ...source, file: f.file }],
      state: blocker === 'state' ? 'dismissed' : 'pending',
    };
    insert(f.sql, initial);
    if (blocker === 'sql-revision') f.sql.exec('UPDATE proposals SET revision = revision + 1');
    const owner = f.store.claimCaptureWorker();
    try {
      const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
      capture.review.page();
      if (blocker === 'context') {
        f.store.claimReview();
        f.store.releaseReview();
      }
      const before = raw(f.sql);
      const notice = f.store.proposalNotice();
      const same = {
        ...submission,
        id: initial.id,
        expectedRevision: initial.revision - Number(blocker === 'revision'),
      };
      expect(() =>
        f.store.finishCaptureJob(
          owner,
          capture.attempt,
          blocker === 'repeated' ? [same, same] : [same],
        ),
      ).toThrow(
        blocker === 'repeated'
          ? 'Repeated proposal'
          : blocker === 'context'
            ? 'context changed'
            : blocker === 'sql-revision'
              ? 'revision'
              : blocker,
      );
      expect(raw(f.sql)).toEqual(before);
      expect(f.store.proposalNotice()).toEqual(notice);
      expect(f.store.reviewed()).toEqual([]);
      expect(f.store.captureJob(capture.manifest.id)?.state).toBe('queued');
    } finally {
      owner.release();
      f.sql.close();
      f.store.close();
    }
  },
);

it.each(['change', 'explanation', 'question'] as const)(
  'protects an edited draft when submitted %s changes without new evidence',
  (field) => {
    const f = fixture();
    const draft: ProposalDraft = {
      change: { operation: 'add', fields: { description: 'My edit' }, annotations: [] },
      expected: null,
      question: null,
    };
    const initial = { ...proposal, draft, sources: [{ ...source, file: f.file }] };
    insert(f.sql, initial);
    const owner = f.store.claimCaptureWorker();
    try {
      const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
      capture.review.page();
      const [saved] = f.store.finishCaptureJob(owner, capture.attempt, [
        {
          ...submission,
          id: initial.id,
          expectedRevision: initial.revision,
          ...(field === 'change'
            ? { change: { ...submission.change, annotations: ['New content'] } }
            : field === 'explanation'
              ? { explanation: 'A different interpretation' }
              : { question: 'A new question' }),
        },
      ]);
      expect(saved!.revision).toBe(initial.revision + 1);
      expect(saved!.sources).toEqual(initial.sources);
      expect(saved!.draft!.change).toEqual(draft.change);
      expect(saved!.question).toBe(field === 'question' ? 'A new question' : null);
      expect(saved!.draft!.question).toMatch(/conflicts/);
    } finally {
      owner.release();
      f.sql.close();
      f.store.close();
    }
  },
);

it.each([null, 'An earlier question'])(
  'blocks a changed question after resolving a draft conflict (previous question: %s)',
  (previousQuestion) => {
    const f = fixture();
    insert(f.sql, { ...proposal, sources: [{ ...source, file: f.file }] });
    const draft: ProposalDraft = {
      change: { operation: 'add', fields: { description: 'My edit' }, annotations: [] },
      expected: null,
      question: null,
    };
    const owner = f.store.claimCaptureWorker();
    const save = (revision: number, question: string | null) => {
      f.sql.exec('DELETE FROM reviewed_boundaries');
      const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
      capture.review.page();
      return f.store.finishCaptureJob(owner, capture.attempt, [
        {
          ...submission,
          id: proposal.id,
          expectedRevision: revision,
          explanation: 'A different interpretation',
          question,
        },
      ])[0]!;
    };
    try {
      const edited = f.store.editProposal(proposal.id, proposal.revision, draft);
      const conflicted = save(edited.revision, previousQuestion);
      expect(conflicted.draft).toEqual({ ...draft, question: expect.stringMatching(/conflicts/) });
      expect(() => f.store.claimProposal(conflicted.id, conflicted.revision)).toThrow(
        'Resolve proposal question',
      );
      const resolved = f.store.editProposal(conflicted.id, conflicted.revision, draft);
      const resolvedBytes = raw(f.sql);
      const resolvedNotice = f.store.proposalNotice();
      expect(save(resolved.revision, previousQuestion)).toEqual(resolved);
      expect(raw(f.sql)).toEqual(resolvedBytes);
      expect(f.store.proposalNotice()).toEqual(resolvedNotice);

      const question = 'Is the revised timing acceptable?';
      const changed = save(resolved.revision, question);
      expect(changed.question).toBe(question);
      expect(changed.revision).toBe(resolved.revision + 1);
      expect(changed.sources).toEqual(resolved.sources);
      expect(changed.draft).toEqual({ ...draft, question: expect.stringMatching(/conflicts/) });
      expect(f.store.proposalNotice().generation).toBe(resolvedNotice.generation + 1);
      expect(() => f.store.editProposal(changed.id, resolved.revision, draft)).toThrow('revision');
      expect(() => f.store.claimProposal(changed.id, resolved.revision)).toThrow('revision');
      expect(() => f.store.claimProposal(changed.id, changed.revision)).toThrow(
        'Resolve proposal question',
      );

      const changedBytes = raw(f.sql);
      const changedNotice = f.store.proposalNotice();
      expect(save(changed.revision, question)).toEqual(changed);
      expect(raw(f.sql)).toEqual(changedBytes);
      expect(f.store.proposalNotice()).toEqual(changedNotice);
      expect(() => f.store.claimProposal(changed.id, changed.revision)).toThrow(
        'Resolve proposal question',
      );

      const resolvedAgain = f.store.editProposal(changed.id, changed.revision, draft);
      const resolvedAgainBytes = raw(f.sql);
      const resolvedAgainNotice = f.store.proposalNotice();
      expect(save(resolvedAgain.revision, question)).toEqual(resolvedAgain);
      expect(raw(f.sql)).toEqual(resolvedAgainBytes);
      expect(f.store.proposalNotice()).toEqual(resolvedAgainNotice);
      expect(f.store.claimProposal(resolvedAgain.id, resolvedAgain.revision).state).toBe(
        'applying',
      );
    } finally {
      owner.release();
      f.sql.close();
      f.store.close();
    }
  },
);

it('deduplicates existing sources without manufacturing a draft conflict', () => {
  const f = fixture();
  const draft: ProposalDraft = {
    change: submission.change,
    expected: null,
    question: 'My question',
  };
  const initial = {
    ...proposal,
    draft,
    sources: Array.from({ length: 100 }, () => ({ ...source, file: f.file })),
  };
  insert(f.sql, initial);
  const owner = f.store.claimCaptureWorker();
  try {
    const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
    capture.review.page();
    const [saved] = f.store.finishCaptureJob(owner, capture.attempt, [
      { ...submission, id: initial.id, expectedRevision: initial.revision },
    ]);
    expect(saved!.sources).toEqual([{ ...source, file: f.file }]);
    expect(saved!.revision).toBe(initial.revision + 1);
    expect(saved!.draft).toEqual(draft);
    expect(saved!.question).toBeNull();
  } finally {
    owner.release();
    f.sql.close();
    f.store.close();
  }
});

it('skips identical draft writes but revises meaningful drafts and application transitions without snapshots', () => {
  const f = fixture();
  insert(f.sql, proposal);
  try {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01'));
    const draft: ProposalDraft = { change: submission.change, expected: null, question: null };
    const edited = f.store.editProposal(proposal.id, proposal.revision, draft);
    expect(edited.revision).toBe(proposal.revision + 1);
    const before = raw(f.sql);
    const notice = f.store.proposalNotice();
    for (let index = 0; index < 100; index++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 2, 1, 0, 0, index)));
      // Object key order is not a content change.
      expect(
        f.store.editProposal(edited.id, edited.revision, {
          question: null,
          expected: null,
          change: { annotations: [], fields: { description: 'Keep promise' }, operation: 'add' },
        }),
      ).toEqual(edited);
      expect(raw(f.sql)).toEqual(before);
      expect(f.store.proposalNotice()).toEqual(notice);
    }
    const claimed = f.store.claimProposal(edited.id, edited.revision, null);
    expect(claimed.revision).toBe(edited.revision + 1);
    expect(claimed.updatedAt).not.toBe(edited.updatedAt);
    const uncertain = f.store.recordProposalResult(claimed.id, claimed.revision, claimed.claim!, {
      state: 'uncertain',
      verified: null,
      error: 'Unknown outcome',
    });
    expect(uncertain.revision).toBe(claimed.revision + 1);
    expect(() => f.store.claimProposal(uncertain.id, uncertain.revision)).toThrow('state');
    expect(() => f.store.editProposal(uncertain.id, uncertain.revision, draft)).toThrow('state');
    expect(() =>
      f.store.recordProposalResult(uncertain.id, uncertain.revision, 'wrong', uncertain.result!),
    ).toThrow('claim');
    expect(
      f.store.recordProposalResult(
        uncertain.id,
        uncertain.revision,
        uncertain.claim!,
        uncertain.result!,
      ),
    ).toEqual(uncertain);
    expect(JSON.parse(raw(f.sql)!['body'] as string)).not.toHaveProperty('history');
  } finally {
    f.sql.close();
    f.store.close();
  }
});

it('repairs existing duplicates plus one novel passage with one new entry and revision, protecting an edited draft', () => {
  const f = fixture();
  const draft: ProposalDraft = {
    change: { operation: 'add', fields: { description: 'My edit' }, annotations: [] },
    expected: null,
    question: null,
  };
  const initial = {
    ...proposal,
    draft,
    sources: Array.from({ length: 100 }, () => ({ ...source, file: f.file })),
  };
  insert(f.sql, initial);
  const owner = f.store.claimCaptureWorker();
  try {
    const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
    capture.review.page();
    const [saved] = f.store.finishCaptureJob(owner, capture.attempt, [
      {
        ...submission,
        id: initial.id,
        expectedRevision: initial.revision,
        references: [reference, { ...reference, offset: 8 }, reference],
      },
    ]);
    expect(saved!.sources).toEqual([
      { ...source, file: f.file },
      { ...source, file: f.file, offset: 8 },
    ]);
    expect(saved!.revision).toBe(initial.revision + 1);
    expect(saved!.draft!.change).toEqual(draft.change);
    expect(saved!.question).toBeNull();
    expect(saved!.draft!.question).toMatch(/conflicts/);
    expect(saved).not.toHaveProperty('history');
  } finally {
    owner.release();
    f.sql.close();
    f.store.close();
  }
});

it('retains many distinct passages with linear persisted growth and no snapshots', () => {
  const f = fixture();
  writeFileSync(
    f.file,
    [
      { type: 'session', id: 'session', cwd: '/synthetic' },
      {
        type: 'message',
        id: 'leaf',
        parentId: null,
        timestamp: '2026-01-01',
        message: { role: 'user', content: 'x'.repeat(300) },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  const owner = f.store.claimCaptureWorker();
  let saved: Proposal | undefined;
  const sizes: number[] = [];
  try {
    for (let index = 0; index < 200; index++) {
      f.sql.exec('DELETE FROM reviewed_boundaries');
      const capture = captureJob(f.store, { sessionId: 'session', file: f.file }, owner);
      capture.review.page();
      [saved] = f.store.finishCaptureJob(owner, capture.attempt, [
        {
          ...submission,
          ...(saved ? { id: saved.id, expectedRevision: saved.revision } : {}),
          references: [{ ...reference, offset: index, quote: 'x' }],
        },
      ]);
      const body = raw(f.sql, saved!.id)!['body'] as string;
      expect(JSON.parse(body)).not.toHaveProperty('history');
      sizes.push(Buffer.byteLength(body));
    }
    expect(saved!.sources.map((item) => item.offset)).toEqual(
      Array.from({ length: 200 }, (_, index) => index),
    );
    expect(saved!.revision).toBe(200);
    const firstHalf = sizes[99]! - sizes[0]!;
    const secondHalf = sizes[199]! - sizes[99]!;
    expect(secondHalf / firstHalf).toBeGreaterThan(0.95);
    expect(secondHalf / firstHalf).toBeLessThan(1.05);
    expect(f.store.proposal(saved!.id)).toEqual(saved);
  } finally {
    owner.release();
    f.sql.close();
    f.store.close();
  }
});
