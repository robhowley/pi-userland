import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { captureJob } from './fixtures/capture-job.js';
import type { Evidence } from '../extensions/remembrancer/evidence.js';
import {
  validateDraft,
  validateSubmission,
  type ProposalSubmission,
  type TaskSnapshot,
} from '../extensions/remembrancer/proposals.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-proposals-'));
  dirs.push(dir);
  return dir;
}
function message(
  id: string,
  parentId: string | null,
  text: string,
  timestamp = '2026-01-01T00:00:00Z',
) {
  return { type: 'message', id, parentId, timestamp, message: { role: 'user', content: text } };
}
function sourceFile(entries = [message('leaf', null, 'Send Maya the comparison tomorrow.')]) {
  const dir = directory();
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [{ type: 'session', id: 'session', cwd: dir }, ...entries]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  return { sessionId: 'session', file };
}
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
    annotations: ['Context: session/leaf'],
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
const snapshot: TaskSnapshot = {
  uuid: '00000000-0000-0000-0000-000000000001',
  status: 'pending',
  fields: { description: 'Send comparison' },
  annotations: [],
};
function freeze(store: CheckpointStore) {
  const frozen = captureJob(store, sourceFile());
  while (frozen.review.page()['hasMore']) {
    /* deliver every continuation */
  }
  return frozen;
}
function durableStore() {
  return new CheckpointStore(join(directory(), 'index.sqlite'));
}

it('persists drafts, decisions and claims across restart; uncertain writes cannot be retried blindly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-'));
  const path = join(dir, 'state.sqlite');
  let store = new CheckpointStore(path);
  try {
    const { owner, attempt } = freeze(store);
    const [first, second] = store.finishCaptureJob(owner, attempt, [submission, submission]);
    owner.release();
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

it.each(['applied', 'already_satisfied', 'uncertain'] as const)(
  'persists matching %s outcome and claim, rejecting invalid outcomes without mutation',
  (state) => {
    const dir = mkdtempSync(join(tmpdir(), 'proposal-result-'));
    const path = join(dir, 'state.sqlite');
    let store = new CheckpointStore(path);
    try {
      const { owner, attempt } = freeze(store);
      const [first] = store.finishCaptureJob(owner, attempt, [submission]);
      owner.release();
      const claim = store.claimProposal(first!.id, first!.revision, null);
      for (const invalid of [
        { state: 'pending', verified: null, error: null },
        { state: 'applied', verified: null, error: null },
        { state: 'uncertain', verified: null, error: '' },
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

it.each([
  { branchId: 'other' },
  { editId: 'later-edit' },
  { entryId: 'other' },
  { sessionId: 'other' },
  { offset: 1 },
  { offset: -1 },
  { offset: 0.5 },
  { quote: 'invented' },
  { quote: '' },
  { file: '/invented' },
])('rejects invalid reference %j without saving any part of capture', (patch) => {
  const store = durableStore();
  try {
    const { owner, attempt } = freeze(store);
    expect(() =>
      store.finishCaptureJob(owner, attempt, [
        submission,
        {
          ...submission,
          references: [{ ...submission.references[0]!, ...patch }],
        },
      ]),
    ).toThrow();
    expect(store.proposals()).toEqual([]);
    expect(store.sources()).toEqual([]);
    expect(store.reviewed()).toEqual([]);
    expect(store.finishCaptureJob(owner, attempt, [])).toEqual([]);
    expect(store.reviewed()).toHaveLength(1);
  } finally {
    store.close();
  }
});

it.each(['missing', 'mismatched'] as const)(
  'refuses %s source scope without coverage or proposals',
  (kind) => {
    const store = durableStore();
    const source = sourceFile();
    try {
      if (kind === 'missing') {
        const frozen = captureJob(store, source);
        frozen.owner.abandon(frozen.attempt);
        rmSync(frozen.manifest.snapshot);
        const attempt = frozen.owner.startAttempt(frozen.manifest.id);
        expect(() => store.prepareCaptureJob(frozen.owner, attempt)).toThrow(
          'snapshot unavailable',
        );
        expect(store.captureJob(frozen.manifest.id)).toMatchObject({
          state: 'failed',
          retryEligible: true,
        });
      } else {
        expect(() => captureJob(store, { ...source, sessionId: 'wrong' })).toThrow(
          'Session identity differs',
        );
      }
      expect(store.proposals()).toEqual([]);
      expect(store.sources()).toEqual([]);
      expect(store.reviewed()).toEqual([]);
    } finally {
      store.close();
    }
  },
);

it('requires every evidence continuation and an explicit array; context does not deliver evidence', () => {
  const store = durableStore();
  const source = sourceFile([
    message('old', null, 'Supporting history'),
    message('leaf', 'old', 'x'.repeat(60_000)),
  ]);
  try {
    store.finish({ sources: [source], checkpoints: [{ ...source, entryId: 'old' }] });
    const { owner, attempt, review: capture } = captureJob(store, source);
    const selected = { sessionId: 'session', branchId: 'leaf', entryId: 'leaf', editId: null };
    expect(capture.context({ batch: capture.id, selected })).toMatchObject({ contextOnly: true });
    expect(() => store.finishCaptureJob(owner, attempt, [])).toThrow(/all evidence/);
    expect(capture.page()['hasMore']).toBe(true);
    expect(() => store.finishCaptureJob(owner, attempt, [])).toThrow(/all evidence/);
    expect(store.proposals()).toEqual([]);
    expect(store.reviewed().map((item) => item.entryId)).toEqual(['old']);
    expect(capture.page()['hasMore']).toBe(false);
    expect(() => store.finishCaptureJob(owner, attempt, undefined as never)).toThrow(
      /proposals array/,
    );
    expect(() => store.finishCaptureJob(owner, attempt, { sources: [source] } as never)).toThrow(
      /proposals array/,
    );
    expect(() => store.finishCaptureJob(owner, { jobId: 'other' }, [])).toThrow(
      /active capture attempt/,
    );
    expect(() =>
      store.finishCaptureJob(owner, attempt, [
        {
          ...submission,
          references: [{ ...selected, entryId: 'old', offset: 0, quote: 'Supporting history' }],
        },
      ]),
    ).toThrow(/eligible evidence/);
    expect(store.finishCaptureJob(owner, attempt, [])).toEqual([]);
    expect(store.proposals()).toEqual([]);
    expect(store.reviewed().map((item) => item.entryId)).toEqual(['old', 'leaf']);
  } finally {
    store.close();
  }
});

it('rechecks proposal revisions at commit and preserves edited drafts/history on new evidence', () => {
  const path = join(directory(), 'state.sqlite');
  let store = new CheckpointStore(path);
  const peer = new CheckpointStore(path);
  const source = sourceFile();
  try {
    const initial = captureJob(store, source);
    const { owner } = initial;
    initial.review.page();
    const [first] = store.finishCaptureJob(owner, initial.attempt, [submission]);
    appendFileSync(
      source.file,
      JSON.stringify(message('later', 'leaf', 'Send Maya updated comparison')) + '\n',
    );
    let { attempt, review: capture } = captureJob(store, source, owner);
    capture.page();
    const correction = {
      ...submission,
      id: first!.id,
      expectedRevision: 1,
      references: [{ ...submission.references[0]!, entryId: 'later', branchId: 'later' }],
    };
    capture.completion([correction]);
    const edited = peer.editProposal(first!.id, 1, {
      change: {
        operation: 'add',
        fields: { description: 'User edited description' },
        annotations: [],
      },
      expected: null,
      question: null,
    });
    expect(() =>
      store.finishCaptureJob(owner, attempt, [
        { ...submission, references: correction.references },
        correction,
      ]),
    ).toThrow(/context changed/);
    store.failCaptureJob(owner, attempt, 'Context changed', true);
    attempt = owner.startAttempt(attempt.jobId);
    capture = store.prepareCaptureJob(owner, attempt);
    capture.page();
    expect(() => store.finishCaptureJob(owner, attempt, [correction])).toThrow(/revision conflict/);
    expect(store.proposals()).toEqual([edited]);
    expect(store.reviewed().map((item) => item.entryId)).toEqual(['leaf']);
    expect(() =>
      store.finishCaptureJob(owner, attempt, [
        { ...correction, expectedRevision: edited.revision },
        { ...correction, expectedRevision: edited.revision },
      ]),
    ).toThrow(/Repeated/);
    const [corrected] = store.finishCaptureJob(owner, attempt, [
      { ...correction, expectedRevision: edited.revision },
    ]);
    expect(corrected!.draft!.change).toEqual(edited.draft!.change);
    expect(corrected!.draft!.question).toMatch(/conflicts/);
    expect(corrected!.history?.at(-1)).toMatchObject({
      revision: edited.revision,
      draft: edited.draft,
    });
    expect(() => store.claimProposal(corrected!.id, corrected!.revision)).toThrow(/question/);
    expect(store.reviewed().map((item) => item.entryId)).toEqual(['leaf', 'later']);
    store.close();
    store = new CheckpointStore(path);
    expect(store.proposal(first!.id)).toEqual(corrected);
  } finally {
    peer.close();
    store.close();
  }
});

it('keeps appends and branch-relative edits after freezing eligible for the next review', () => {
  const store = durableStore();
  const source = sourceFile([
    message('root', null, 'Original promise'),
    message('left', 'root', 'Left promise'),
    message('right', 'root', 'Right promise'),
  ]);
  try {
    const { owner, attempt, review: capture } = captureJob(store, source);
    appendFileSync(
      source.file,
      [
        {
          type: 'context_edit',
          id: 'edit',
          parentId: 'right',
          timestamp: '2026-01-02',
          targetId: 'root',
          replacement: { content: 'Edited promise' },
        },
        message('append', 'left', 'Late promise'),
      ]
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n',
    );
    const page = capture.page() as {
      groups: { branchId: string; entries: { entryId: string; text: string }[] }[];
    };
    expect(page.groups.map((group) => group.branchId)).toEqual(['left', 'right']);
    expect(page.groups.flatMap((group) => group.entries).map((item) => item.text)).not.toContain(
      'Edited promise',
    );
    const reference = {
      sessionId: 'session',
      branchId: 'right',
      entryId: 'root',
      editId: null,
      offset: 9,
      quote: 'promise',
    };
    expect(() =>
      store.finishCaptureJob(owner, attempt, [
        { ...submission, references: [{ ...reference, editId: 'edit' }] },
      ]),
    ).toThrow(/eligible evidence/);
    const [saved] = store.finishCaptureJob(owner, attempt, [
      { ...submission, references: [reference] },
    ]);
    expect(saved!.sources[0]).toMatchObject(reference);
    expect(store.reviewed().map((item) => item.entryId)).toEqual(['left', 'right']);
    const { review: next } = captureJob(store, source, owner);
    const later = next.page() as {
      groups: { entries: { entryId: string; editId: string | null; text: string }[] }[];
    };
    expect(later.groups.flatMap((group) => group.entries)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryId: 'root', editId: 'edit', text: 'Edited promise' }),
        expect.objectContaining({ entryId: 'append', text: 'Late promise' }),
      ]),
    );
  } finally {
    store.close();
  }
});

it('validates and saves the exact frozen edited selection, not the original text', () => {
  const store = durableStore();
  const source = sourceFile([message('root', null, 'Original promise')]);
  appendFileSync(
    source.file,
    JSON.stringify({
      type: 'context_edit',
      id: 'edit',
      parentId: 'root',
      timestamp: '2026-01-02',
      targetId: 'root',
      replacement: { content: 'New edited promise' },
    }) + '\n',
  );
  try {
    const { owner, attempt, review: capture } = captureJob(store, source);
    capture.page();
    const reference = {
      sessionId: 'session',
      branchId: 'edit',
      entryId: 'root',
      editId: 'edit',
      offset: 4,
      quote: 'edited promise',
    };
    for (const patch of [
      { editId: null },
      { branchId: 'root' },
      { offset: 0 },
      { quote: 'Original promise' },
    ]) {
      expect(() =>
        store.finishCaptureJob(owner, attempt, [
          { ...submission, references: [{ ...reference, ...patch }] },
        ]),
      ).toThrow(/eligible evidence/);
      expect(store.proposals()).toEqual([]);
      expect(store.sources()).toEqual([]);
      expect(store.reviewed()).toEqual([]);
    }
    const [saved] = store.finishCaptureJob(owner, attempt, [
      { ...submission, references: [reference] },
    ]);
    expect(saved!.sources[0]).toMatchObject({ ...reference, file: source.file });
    expect(store.reviewed()).toEqual([{ ...source, entryId: 'edit', since: null }]);
  } finally {
    store.close();
  }
});

it('uses enrolled seed defaults and treats frozen context as supporting text only', () => {
  const store = durableStore();
  const source = sourceFile([
    message('old', null, 'Historical promise', '2025-01-01'),
    message('leaf', 'old', 'Eligible promise', '2026-01-01'),
  ]);
  try {
    store.finish({
      sources: [source],
      sourceDefaults: [{ sessionId: source.sessionId, since: '2025-12-01' }],
    });
    const { owner, attempt, review: capture } = captureJob(store, source);
    const selected = { sessionId: 'session', branchId: 'leaf', entryId: 'leaf', editId: null };
    appendFileSync(
      source.file,
      JSON.stringify(message('late', 'leaf', 'Not in frozen context')) + '\n',
    );
    expect(capture.context({ batch: capture.id, selected })).toMatchObject({
      groups: [{ entries: [{ text: 'Historical promise' }] }],
    });
    capture.page();
    expect(() =>
      store.finishCaptureJob(owner, attempt, [
        {
          ...submission,
          references: [{ ...selected, entryId: 'old', offset: 0, quote: 'Historical promise' }],
        },
      ]),
    ).toThrow(/eligible evidence/);
    const [saved] = store.finishCaptureJob(owner, attempt, [
      { ...submission, references: [{ ...selected, offset: 0, quote: 'Eligible promise' }] },
    ]);
    expect(saved!.sources[0]?.quote).toBe('Eligible promise');
    expect(store.sources()[0]?.seedSince).toBe('2025-12-01T00:00:00.000Z');
    expect(store.reviewed()).toEqual([
      { ...source, entryId: 'leaf', since: '2025-12-01T00:00:00.000Z' },
    ]);
  } finally {
    store.close();
  }
});

it.each(['empty', 'tool-only'] as const)(
  'skips %s evidence without enrollment or coverage and fences abandoned capture identities',
  (kind) => {
    const store = durableStore();
    const source = sourceFile([]);
    if (kind === 'tool-only')
      appendFileSync(
        source.file,
        JSON.stringify({
          type: 'message',
          id: 'tool',
          parentId: null,
          timestamp: '2026-01-01',
          message: {
            role: 'toolResult',
            content: [{ type: 'text', text: 'Not extraction evidence' }],
          },
        }) + '\n',
      );
    try {
      const { owner, attempt, review: empty } = captureJob(store, source);
      expect(empty.hasEvidence).toBe(false);
      expect(empty.page()['hasMore']).toBe(false);
      expect(() => store.finishCaptureJob(owner, attempt, [submission])).toThrow(/No evidence/);
      expect(store.finishCaptureJob(owner, attempt, [])).toEqual([]);
      expect(store.sources()).toEqual([]);
      expect(store.reviewed()).toEqual([]);
      const next = captureJob(store, sourceFile(), owner);
      next.review.page();
      expect(() => empty.page()).toThrow(/active capture attempt/);
      expect(() => store.finishCaptureJob(owner, attempt, [])).toThrow(/active capture attempt/);
      store.finishCaptureJob(owner, next.attempt, []);
    } finally {
      store.close();
    }
  },
);

it('adds only proposal storage, preserving legacy coverage and unknown tables with private files', () => {
  const path = join(directory(), 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE sources (session_id TEXT PRIMARY KEY, session_file TEXT NOT NULL);
    CREATE TABLE reviewed_boundaries (session_id TEXT NOT NULL, tip_id TEXT NOT NULL, PRIMARY KEY (session_id, tip_id));
    CREATE TABLE review_lease (unrelated TEXT);
    INSERT INTO review_lease VALUES ('untouched');
    INSERT INTO sources VALUES ('legacy', '/legacy.jsonl');
    INSERT INTO reviewed_boundaries VALUES ('legacy', 'covered');
  `);
  legacy.close();
  chmodSync(path, 0o644);
  const store = new CheckpointStore(path);
  try {
    expect(store.proposals()).toEqual([]);
    expect(store.sources()).toEqual([
      { sessionId: 'legacy', file: '/legacy.jsonl', seedSince: null },
    ]);
    expect(store.reviewed()).toEqual([
      { sessionId: 'legacy', file: '/legacy.jsonl', entryId: 'covered', since: null },
    ]);
    store.claimReview();
    store.releaseReview();
    const inspect = new DatabaseSync(path);
    try {
      expect(inspect.prepare('SELECT * FROM review_lease').all()).toEqual([
        { unrelated: 'untouched' },
      ]);
    } finally {
      inspect.close();
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    store.close();
  }
});
