import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import {
  captureIsSatisfied,
  resolveCaptureMatches,
} from '../extensions/remembrancer/capture-matches.js';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';
import {
  folded,
  validateMaterialization,
  type FindingRecord,
  type FoldedFinding,
} from '../extensions/remembrancer/review-findings.js';
import { runReviewerStep, type ReviewerStepInput } from '../extensions/remembrancer/reviewer.js';
import { readTaskCatalog, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import { answerCapture } from './fixtures/capture-steps.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewerStep: vi.fn() }));
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));
const uuid = '12345678-1234-1234-1234-123456789abc';
const otherUuid = '12345678-1234-1234-1234-123456789abd';
const task = { uuid, status: 'pending', description: 'Comparison' };
const add = { operation: 'add' as const, fields: { description: 'Comparison' }, annotations: [] };
const active: FoldedFinding = {
  summary: 'Comparison',
  status: 'active',
  draft: { change: add, question: null },
};
const record: FindingRecord = { id: 'r', label: 'Comparison', findings: [], ambiguous: false };
const disposition = (change = add, question: string | null = null) => ({
  reason: 'Exact evidence',
  submission: { change, question, explanation: 'Exact evidence' },
});

describe('materialization boundary', () => {
  it.each([['uncertain'], { toString: () => 'uncertain' }, 1, null])(
    'rejects a non-string lifecycle %j',
    (status) => {
      expect(() => folded({ ...active, status })).toThrow('finding status');
    },
  );
  it('accepts existing-task intent without asking the model to reproduce a snapshot', () => {
    expect(
      folded({
        ...active,
        draft: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: { due: '20261201' },
            annotations: [],
          },
          question: null,
        },
      }).draft?.expected,
    ).toBeUndefined();
  });
  it('does not dispose an active obligation for a reason string alone', () => {
    expect(() =>
      validateMaterialization({ reason: 'Need more context', submission: null }, record, active),
    ).toThrow('Active capture');
  });
  it.each(['uncertain', 'active'] as const)('does not checkpoint ambiguous null (%s)', (status) => {
    expect(() =>
      validateMaterialization(
        { reason: 'Unknown', submission: null },
        { ...record, ambiguous: true },
        { ...active, status },
      ),
    ).toThrow('requires a question');
  });
  it('rejects question-free materialization of ambiguous identity', () => {
    expect(() =>
      validateMaterialization(disposition(), { ...record, ambiguous: true }, active),
    ).toThrow('requires a question');
  });
  it.each(['refused', 'uncertain'] as const)(
    'rejects question-free %s materialization',
    (status) => {
      expect(() => validateMaterialization(disposition(), record, { ...active, status })).toThrow(
        'requires a question',
      );
    },
  );
  it('preserves an evidence question even when the materializer omits it', () => {
    const state = { ...active, draft: { ...active.draft!, question: 'Tuesday or Thursday?' } };
    expect(validateMaterialization(disposition(), record, state)?.question).toBe(
      'Tuesday or Thursday?',
    );
    expect(() =>
      validateMaterialization({ reason: 'No change', submission: null }, record, state),
    ).toThrow('preserve unresolved questions');
  });
  it.each(['id', 'expectedRevision', 'references'])(
    'rejects model-selected %s independently',
    (key) => {
      const value = disposition();
      Object.assign(value.submission, { [key]: key === 'references' ? [] : 'forged' });
      expect(() => validateMaterialization(value, record, active)).toThrow(
        'cannot select references or proposal identity',
      );
    },
  );
  it.each(['add', 'update'] as const)(
    'completed evidence cannot become a question-free %s',
    (operation) => {
      const change =
        operation === 'add'
          ? add
          : {
              operation,
              targetUuid: uuid,
              fields: { due: '20261201' },
              annotations: [],
            };
      expect(() =>
        validateMaterialization(
          { reason: 'Done', submission: { change, question: null, explanation: 'Done' } },
          record,
          { ...active, status: 'completed' },
          { expected: snapshot(task) },
        ),
      ).toThrow('requires a question');
    },
  );
  it('validates intent before binding the trusted snapshot', () => {
    const value = {
      reason: 'Update',
      submission: {
        change: {
          operation: 'update',
          targetUuid: uuid,
          fields: { priority: ['H'] },
          annotations: [],
        },
        question: null,
        explanation: 'Update',
        expected: { forged: true },
      },
    };
    expect(() =>
      validateMaterialization(value, record, active, { expected: snapshot(task) }),
    ).toThrow('Invalid priority');
  });
});

let dir: string;
let current: CaptureReview;
let evidenceBranchId: string;
let rows: Proposal[];
const runner = vi.mocked(runReviewerStep);
const model = { contextWindow: 32768, maxTokens: 2048 } as NonNullable<ReviewerStepInput['model']>;
const db = {
  contextGeneration: () => 0,
  proposals: (_state: unknown, offset: number, limit: number) => rows.slice(offset, offset + limit),
  proposal: (id: string) => rows.find((row) => row.id === id),
} as CheckpointStore;
function transcript(texts = ['accepted:comparison|Comparison']) {
  const file = join(dir, 'synthetic.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'synthetic', cwd: dir },
      ...texts.map((text, index) => ({
        type: 'message',
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        message: { role: 'user', content: text },
      })),
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  const prepared = prepareReview([{ file, sessionId: 'synthetic' }], []);
  evidenceBranchId = prepared.evidence[0]!.branchId;
  current = new CaptureReview(prepared, () => {});
}
function proposal(state: Proposal['state'] = 'pending', id = 'saved'): Proposal {
  return {
    id,
    state,
    revision: 3,
    change: add,
    expected: null,
    question: null,
    draft: null,
    explanation: 'Synthetic',
    sources: [],
    claim: null,
    result: null,
    createdAt: '',
    updatedAt: '',
  };
}
const run = () =>
  reviewPreparedCapture(current, db, { cwd: dir, sessionId: 'synthetic', model }, () => {});
// This local provider deliberately keeps separate records so final identity grouping is exercised.
type MatchWork = { state: FoldedFinding; observation: { label: string } };
function provider(
  options: {
    exact?: (work: MatchWork) => unknown;
    fold?: (work: MatchWork) => unknown;
    materialize?: (work: MatchWork) => unknown;
  } = {},
) {
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    let answer: unknown;
    if (work.range)
      answer = {
        complete: true,
        observations: [
          {
            kind: work.range.text.split(':')[0],
            label: work.range.text.split('|')[0],
            start: work.range.offset,
            end: work.range.end,
          },
        ],
      };
    else if (work.catalogue)
      answer = {
        candidates: work.catalogue
          .filter((item: { handle?: string }) => item.handle)
          .map((item: { handle: string }) => item.handle),
      };
    else if (input.instruction.includes('All exact candidate fields'))
      answer = options.exact?.(work) ?? { match: 'same' };
    else if (work.page) answer = { notes: 'Exact synthetic fields' };
    else if (work.observation)
      answer = options.fold?.(work) ?? {
        ...active,
        status: work.observation.kind === 'completion' ? 'completed' : 'active',
      };
    else if (input.instruction.includes('Materialize'))
      answer = options.materialize?.(work) ?? disposition();
    else throw new Error('Unexpected synthetic step');
    return answerCapture(input, answer);
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-disposition-'));
  rows = [];
  runner.mockReset();
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
  transcript();
  provider();
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

it.each([null, 'Which day?'])(
  'uses a validated unmatched accepted add directly, preserving question %j',
  async (question) => {
    const materialize = vi.fn(() => disposition());
    provider({
      fold: () => ({ ...active, draft: { change: add, question } }),
      materialize,
    });
    const submissions = await run();
    expect(materialize).not.toHaveBeenCalled();
    expect(submissions).toEqual([
      {
        change: add,
        expected: null,
        question,
        explanation: active.summary,
        references: [
          {
            sessionId: 'synthetic',
            branchId: evidenceBranchId,
            entryId: 'entry-0',
            editId: null,
            offset: 0,
            quote: 'accepted:comparison|Comparison',
          },
        ],
      },
    ]);
    expect(() => current.completion(submissions)).not.toThrow();
  },
);
it.each(['correction', 'progress', 'reference', 'refusal', 'completion', 'accepted'])(
  'does not use a question-free active draft to bypass unmatched or ambiguous %s evidence',
  async (kind) => {
    transcript([`${kind}:comparison|That comparison`]);
    if (kind === 'accepted') vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    const materialize = vi.fn((work: MatchWork) => {
      expect(work).toMatchObject({ ambiguous: true, state: active });
      return disposition();
    });
    provider({ fold: () => active, exact: () => ({ match: 'ambiguous' }), materialize });
    await expect(run()).rejects.toThrow('requires a question');
    expect(materialize).toHaveBeenCalledOnce();
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it.each([false, true])('does not pick a task by candidate order (reverse=%s)', async (reverse) => {
  const tasks = [task, { ...task, uuid: otherUuid }];
  vi.mocked(readTaskCatalog).mockResolvedValue(reverse ? tasks.reverse() : tasks);
  provider({ materialize: () => disposition(add, 'Which comparison?') });
  const submissions = await run();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ change: add, question: 'Which comparison?' });
  expect(submissions[0]!.id).toBeUndefined();
  expect(submissions[0]!.expected).toBeNull();
});
it.each([false, true])(
  'does not pick a pending row by candidate order (reverse=%s)',
  async (reverse) => {
    rows = [proposal('pending', 'one'), proposal('pending', 'two')];
    if (reverse) rows.reverse();
    provider({ materialize: () => disposition(add, 'Which pending interpretation?') });
    const submissions = await run();
    expect(submissions[0]!.id).toBeUndefined();
    expect(submissions[0]!.expectedRevision).toBeUndefined();
    expect(rows.map((row) => row.revision)).toEqual([3, 3]);
  },
);
it('never binds a materializer-selected UUID from an ambiguous exact match set', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task, { ...task, uuid: otherUuid }]);
  provider({
    materialize: () => ({
      reason: 'Guess',
      submission: {
        change: { operation: 'complete', targetUuid: uuid, annotations: [] },
        question: 'Which task?',
        explanation: 'Guess',
      },
    }),
  });
  await expect(run()).rejects.toThrow('not uniquely matched');
  expect(() => current.completion([])).toThrow('reconciliation');
});
it.each(['applying', 'uncertain'] as const)(
  'cannot create another pending add for a %s saved add',
  async (state) => {
    rows = [proposal(state)];
    await expect(run()).rejects.toThrow('verify-only');
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it.each(['applying', 'uncertain'] as const)(
  'allows only a live verified no-change outcome for a %s saved application',
  async (state) => {
    rows = [{ ...proposal(state), claim: uuid }];
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    provider({
      materialize: (work) => {
        expect(work).toMatchObject({ satisfied: true, verifyOnly: true });
        return {
          reason: 'The live task proves both operations already satisfied',
          submission: null,
        };
      },
    });
    expect(await run()).toEqual([]);
    expect(() => current.completion([])).not.toThrow();
    expect(rows[0]!.state).toBe(state); // Capture never resolves or replays the saved application.
  },
);
it.each(['applying', 'uncertain'] as const)(
  'does not confuse a brand new change with a verified retry of a %s saved application',
  async (state) => {
    rows = [{ ...proposal(state), claim: uuid }];
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    const next = {
      ...active,
      draft: {
        change: {
          operation: 'update' as const,
          targetUuid: uuid,
          fields: { priority: 'H' as const },
          annotations: [],
        },
        question: null,
      },
    };
    provider({
      fold: () => next,
      materialize: (work) => {
        expect(work).toMatchObject({ satisfied: false, verifyOnly: true });
        return { reason: 'Old add succeeded, but the new priority has not', submission: null };
      },
    });
    await expect(run()).rejects.toThrow('verify-only');
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it.each(['applying', 'uncertain'] as const)(
  'does not checkpoint an unresolved %s application as completed null',
  async (state) => {
    transcript(['completion:comparison|I sent it.']);
    rows = [proposal(state)];
    provider({ materialize: () => ({ reason: 'Already done', submission: null }) });
    await expect(run()).rejects.toThrow('verify-only');
    expect(rows[0]!.state).toBe(state);
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it.each([false, true])(
  'ambiguous completions cannot silently checkpoint (reverse=%s)',
  async (reverse) => {
    const tasks = [task, { ...task, uuid: otherUuid }];
    transcript(['completion:comparison|I sent it.']);
    vi.mocked(readTaskCatalog).mockResolvedValue(reverse ? tasks.reverse() : tasks);
    provider({ materialize: () => ({ reason: 'Already done', submission: null }) });
    await expect(run()).rejects.toThrow('requires a question');
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it('does not let a match reply rewrite completion into active intent', async () => {
  transcript(['completion:comparison|I sent it.']);
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  provider({
    exact: () => ({ match: 'same', state: active }),
    materialize: () => ({
      reason: 'Update',
      submission: {
        change: {
          operation: 'update',
          targetUuid: uuid,
          fields: { due: '20261201' },
          annotations: [],
        },
        question: null,
        explanation: 'Update',
      },
    }),
  });
  await expect(run()).rejects.toThrow('requires a question');
});
it('does not revise a pending UUID contradicted by the evidence intent', async () => {
  rows = [
    {
      ...proposal(),
      change: {
        operation: 'update',
        targetUuid: otherUuid,
        fields: { project: 'Review' },
        annotations: [],
      },
      expected: snapshot({ ...task, uuid: otherUuid }),
    },
  ];
  provider({
    fold: () => ({
      ...active,
      draft: {
        change: {
          operation: 'update',
          targetUuid: uuid,
          fields: { project: 'Review' },
          annotations: [],
        },
        question: null,
      },
    }),
    materialize: () => disposition(add, 'Which UUID did you mean?'),
  });
  const submissions = await run();
  expect(submissions[0]!.id).toBeUndefined();
  expect(submissions[0]!.expected).toBeNull();
});
it.each(['references', 'id', 'expectedRevision'])(
  'rejects materializer-selected %s even when it names valid frozen data',
  async (field) => {
    transcript(['accepted:first|First obligation', 'accepted:second|Second obligation']);
    rows = [proposal()];
    provider({
      exact: () => ({ match: 'different' }),
      fold: () => ({ ...active, draft: null }),
      materialize: () => ({
        reason: 'Forged provenance or identity',
        submission: {
          ...disposition().submission,
          [field]:
            field === 'references'
              ? [
                  {
                    sessionId: 'synthetic',
                    branchId: evidenceBranchId,
                    entryId: 'entry-1',
                    editId: null,
                    offset: 0,
                    quote: 'accepted:second|Second obligation',
                  },
                ]
              : field === 'id'
                ? rows[0]!.id
                : rows[0]!.revision,
        },
      }),
    });
    await expect(run()).rejects.toThrow('cannot select references or proposal identity');
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it('uses the same immutable evidence state for every candidate', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task, { ...task, uuid: otherUuid }]);
  const seen: unknown[] = [];
  provider({
    exact: (work) => {
      seen.push(work.state);
      return { match: 'same', state: { ...active, status: 'completed' } };
    },
    materialize: () => disposition(add, 'Which task?'),
  });
  await run();
  expect(seen).toEqual([active, active]);
});
it.each([['same'], { match: 'same' }, null])('rejects non-string exact match %j', async (match) => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  provider({ exact: () => ({ match }) });
  await expect(run()).rejects.toThrow('Invalid existing match');
});
it('accepts explicit untracked completion without manufacturing an ambiguous add', async () => {
  transcript(['completion:comparison|I sent the comparison.']);
  provider({ materialize: () => ({ reason: 'Untracked completion', submission: null }) });
  expect(await run()).toEqual([]);
  expect(() => current.completion([])).not.toThrow();
});
it.each(['pending', 'completed'])(
  'requires observable completion before a tracked null (%s)',
  async (status) => {
    transcript(['completion:comparison|I sent it.']);
    vi.mocked(readTaskCatalog).mockResolvedValue([{ ...task, status }]);
    provider({ materialize: () => ({ reason: 'Completed', submission: null }) });
    if (status === 'completed') expect(await run()).toEqual([]);
    else await expect(run()).rejects.toThrow('Tracked capture');
  },
);
it('keeps an unanchored reference ambiguous even if folding calls it completed', async () => {
  transcript(['reference:it|That one.']);
  provider({
    fold: () => ({ ...active, status: 'completed' }),
    materialize: () => ({ reason: 'Done', submission: null }),
  });
  await expect(run()).rejects.toThrow('requires a question');
});
it('binds a truly matched completed row to its full host snapshot, not a model snapshot', async () => {
  const completed = {
    ...task,
    status: 'completed',
    annotations: [{ entry: '20261124T010000Z', description: 'Original annotation' }],
  };
  vi.mocked(readTaskCatalog).mockResolvedValue([completed]);
  transcript(['completion:comparison|I sent the comparison.']);
  provider({
    materialize: () => ({
      reason: 'Completion',
      submission: {
        change: { operation: 'complete', targetUuid: uuid, annotations: [] },
        expected: { forged: true },
        question: null,
        explanation: 'Explicit completion',
      },
    }),
  });
  const submissions = await run();
  expect(submissions[0]!.expected).toEqual(snapshot(completed));
  expect(submissions[0]!.change).toEqual({
    operation: 'complete',
    targetUuid: uuid,
    annotations: [],
  });
});
it('rejects active null but accepts a host-proved no-op', async () => {
  provider({
    fold: () => ({ ...active, draft: null }),
    materialize: () => ({ reason: 'No change', submission: null }),
  });
  await expect(run()).rejects.toThrow('Active capture');
  expect(() => current.completion([])).toThrow('reconciliation');
  transcript();
  provider({ materialize: () => ({ reason: 'No change', submission: null }) });
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  expect(await run()).toEqual([]);
});
it.each([false, true])(
  'groups compatible same-target records and keeps unrelated evidence (reverse=%s)',
  async (reverse) => {
    const evidence = [
      'accepted:due|Set due',
      'accepted:project|Set project',
      'accepted:unrelated|Separate task',
    ];
    transcript(reverse ? [...evidence].reverse() : evidence);
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    provider({
      fold: (work) => {
        const label: string = work.observation.label;
        const fields = label.includes('due') ? { due: '20261201' } : { project: 'Review' };
        return {
          ...active,
          summary: label,
          draft: {
            change: label.includes('unrelated')
              ? { ...add, fields: { description: 'Separate task' } }
              : { operation: 'update', targetUuid: uuid, fields, annotations: [] },
            question: null,
          },
        };
      },
      exact: (work) => ({ match: work.state.summary.includes('unrelated') ? 'different' : 'same' }),
      materialize: (work) =>
        work.state.summary.includes('unrelated')
          ? {
              reason: 'Separate',
              submission: { ...work.state.draft, explanation: 'Separate' },
            }
          : {
              reason: 'Consolidated',
              submission: {
                change: {
                  operation: 'update',
                  targetUuid: uuid,
                  fields: { due: '20261201', project: 'Review' },
                  annotations: [],
                },
                question: null,
                explanation: 'Both changes',
              },
            },
    });
    const submissions = await run();
    expect(submissions).toHaveLength(2);
    const update = submissions.find((submission) => submission.change.operation === 'update')!;
    expect(update.expected).toEqual(snapshot(task));
    expect(new Set(update.references.map((ref) => ref.quote))).toEqual(
      new Set(evidence.slice(0, 2)),
    );
    const separate = submissions.find((submission) => submission.change.operation === 'add')!;
    expect(separate.references.map((ref) => ref.quote)).toEqual([evidence[2]]);
    expect(() => current.completion(submissions)).not.toThrow();
  },
);
it.each(['fields', 'annotations'])(
  'does not drop compatible requested %s while consolidating',
  async (omitted) => {
    transcript(['accepted:due|Set due', 'accepted:project|Set project']);
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    provider({
      fold: (work) => ({
        ...active,
        draft: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: work.observation.label.includes('due')
              ? { due: '20261201' }
              : { project: 'Review' },
            annotations: work.observation.label.includes('due') ? ['Keep this note'] : [],
          },
          question: null,
        },
      }),
      materialize: () => ({
        reason: 'Incomplete consolidation',
        submission: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields:
              omitted === 'fields' ? { due: '20261201' } : { due: '20261201', project: 'Review' },
            annotations: omitted === 'annotations' ? [] : ['Keep this note'],
          },
          question: null,
          explanation: 'Incomplete consolidation',
        },
      }),
    });
    await expect(run()).rejects.toThrow(`Consolidation dropped requested ${omitted}`);
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it('groups two confirmations of a pending row into one revision with both references', async () => {
  transcript(['accepted:first|Comparison', 'accepted:second|Same comparison']);
  rows = [{ ...proposal(), question: 'Keep the edited plan?' }];
  const submissions = await run();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    id: 'saved',
    expectedRevision: 3,
    question: 'Keep the edited plan?',
  });
  expect(new Set(submissions[0]!.references.map((ref) => ref.entryId))).toEqual(
    new Set(['entry-0', 'entry-1']),
  );
  expect(rows[0]!.state).toBe('pending');
  expect(rows[0]!.revision).toBe(3);
});
it.each(['applied', 'already_satisfied'] as const)(
  'leaves a matched %s add unresolved when its verified UUID is absent from live tasks',
  async (state) => {
    rows = [{ ...proposal(state), result: { state, verified: snapshot(task), error: null } }];
    expect(captureIsSatisfied(active, resolveCaptureMatches([], rows))).toBe(false);
    const materialize = vi.fn(() => ({ reason: 'Historical result', submission: null }));
    provider({ materialize });
    await expect(run()).rejects.toThrow('no live task; capture unresolved');
    expect(materialize).not.toHaveBeenCalled();
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it.each([false, true])(
  'uses the live renamed task behind a matched applied add as proof (satisfied=%s)',
  async (satisfied) => {
    const renamed = {
      ...task,
      description: 'Renamed comparison',
      project: satisfied ? 'Review' : 'Other',
    };
    rows = [
      {
        ...proposal('applied'),
        result: { state: 'applied', verified: snapshot(task), error: null },
      },
    ];
    vi.mocked(readTaskCatalog).mockResolvedValue([renamed]);
    const materialize = vi.fn((work: MatchWork) => {
      expect(work).toMatchObject({ satisfied, targetUuid: uuid, targetStatus: 'pending' });
      return { reason: 'Only live data can prove this intent', submission: null };
    });
    provider({
      // Simulate discovery/matching recognizing the saved evidence, not the renamed task.
      exact: (work) => ({
        match: (work as MatchWork & { handle: string }).handle.startsWith('proposal:')
          ? 'same'
          : 'different',
      }),
      fold: () => ({
        ...active,
        draft: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: { project: 'Review' },
            annotations: [],
          },
          question: null,
        },
      }),
      materialize,
    });
    if (satisfied) {
      expect(await run()).toEqual([]);
      expect(() => current.completion([])).not.toThrow();
    } else {
      await expect(run()).rejects.toThrow('Tracked capture requires a proposal');
      expect(() => current.completion([])).toThrow('reconciliation');
    }
    expect(materialize).toHaveBeenCalledOnce();
    expect(readTaskCatalog).toHaveBeenCalledOnce();
  },
);
it.each(['third source', 'truncated quote', 'unrelated'] as const)(
  'pages compact saved source cues before excluding a renamed draft (%s)',
  async (scenario) => {
    const background = 'Routine project background. '.repeat(80);
    const thirdQuote =
      scenario === 'third source'
        ? `Comparison promised for Maya. ${background}`
        : scenario === 'truncated quote'
          ? `The original commitment follows this background. ${background} Comparison promised for Maya.`
          : `Maintain the payroll export for Finance. ${background}`;
    rows = [
      {
        ...proposal(),
        change: { ...add, fields: { description: 'Original launch checklist' } },
        draft: {
          change: { ...add, fields: { description: 'Assemble launch briefing' } },
          expected: null,
          question: null,
        },
        explanation: background.repeat(2),
        sources: Array.from({ length: 5 }, (_, index) => ({
          sessionId: 'saved-session',
          branchId: 'saved-branch',
          entryId: `saved-${index}`,
          editId: null,
          file: join(dir, 'never-read.jsonl'),
          role: 'user',
          timestamp: '2026-11-01T00:00:00Z',
          locator: `saved-session:saved-${index}`,
          offset: 0,
          quote: index === 2 ? thirdQuote : `Reviewed the launch checklist. ${background}`,
        })),
      },
    ];
    const offsets: number[] = [];
    let exactCalls = 0;
    runner.mockImplementation(async (input) => {
      const work = JSON.parse(
        input.instruction.slice(input.instruction.lastIndexOf('\n') + 1),
      ).work;
      if (work.catalogue?.[0]?.handle) {
        const candidates: string[] = [];
        for (const item of work.catalogue) {
          const identity = item.identity;
          expect(identity.sources).toHaveProperty('valueHandle');
          expect(identity.sourceClues.length).toBeLessThanOrEqual(2);
          expect(identity.sourceCount).toBe(5);
          offsets.push(identity.sourceClueOffset);
          for (const source of identity.sourceClues) {
            const relevant =
              source.quote.text.includes('Comparison promised') ||
              source.quote.text.includes('The original commitment');
            if (relevant) {
              // A short quote prefix cannot exclude a potentially renamed promise.
              expect(source.quote.truncated).toBe(true);
              if (scenario === 'truncated quote') {
                expect(source.quote.text).not.toContain('Comparison');
                expect(input.instruction).toContain('never reject it from that prefix alone');
              }
              candidates.push(item.handle);
            }
          }
        }
        return answerCapture(input, { candidates });
      }
      if (input.instruction.includes('All exact candidate fields')) {
        exactCalls++;
        expect(work.candidate.sources[2].quote).toBe(thirdQuote);
        return answerCapture(input, { match: 'same' });
      }
      return answerCapture(input);
    });
    const submissions = await run();
    expect(submissions).toHaveLength(1);
    if (scenario === 'unrelated') {
      expect(offsets).toEqual([0, 2, 4]);
      expect(exactCalls).toBe(0); // Long supporting quotes/explanation are not all-pairs detail reads.
      expect(submissions[0]!.id).toBeUndefined();
    } else {
      expect(offsets).toEqual([0, 2]);
      expect(exactCalls).toBe(1);
      expect(submissions[0]).toMatchObject({ id: 'saved', expectedRevision: 3 });
    }
    expect(() => current.completion(submissions)).not.toThrow();
  },
);
it('matches an applied add by its verified UUID after its task was renamed', async () => {
  const renamed = { ...task, description: 'Renamed comparison' };
  rows = [
    { ...proposal('applied'), result: { state: 'applied', verified: snapshot(task), error: null } },
  ];
  vi.mocked(readTaskCatalog).mockResolvedValue([renamed]);
  let verifiedRead = false;
  provider({
    fold: () => ({
      ...active,
      draft: {
        change: {
          operation: 'update',
          targetUuid: uuid,
          fields: { project: 'Review' },
          annotations: [],
        },
        question: null,
      },
    }),
    exact: (work) => {
      const candidate = (work as MatchWork & { candidate: { verified?: { uuid: string } } })
        .candidate;
      if (candidate.verified) verifiedRead = candidate.verified.uuid === uuid;
      return { match: 'same' };
    },
    materialize: (work) => ({
      reason: 'New correction',
      submission: { ...work.state.draft, explanation: 'New evidence' },
    }),
  });
  const submissions = await run();
  expect(verifiedRead).toBe(true);
  expect(submissions[0]!.expected).toEqual(snapshot(renamed));
  expect(submissions[0]!.id).toBeUndefined();
  expect(rows[0]!.state).toBe('applied');
});
it.each([false, true])(
  'does not persist a winner for conflicting same-target records (reverse=%s)',
  async (reverse) => {
    const evidence = ['accepted:tuesday|Tuesday', 'accepted:thursday|Thursday'];
    transcript(reverse ? evidence.reverse() : evidence);
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    provider({
      fold: (work) => ({
        ...active,
        draft: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: { due: work.observation.label.includes('tuesday') ? '20261201' : '20261203' },
            annotations: [],
          },
          question: null,
        },
      }),
      materialize: () => ({
        reason: 'Guess',
        submission: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: { due: '20261201' },
            annotations: [],
          },
          question: null,
          explanation: 'Guess',
        },
      }),
    });
    await expect(run()).rejects.toThrow('requires a question');
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);
it('keeps unrelated proposals when conflicting edits can use a safe question', async () => {
  transcript([
    'accepted:tuesday|Tuesday',
    'accepted:thursday|Thursday',
    'accepted:unrelated|Separate',
  ]);
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  provider({
    fold: (work) => ({
      ...active,
      summary: work.observation.label,
      draft: {
        change: work.observation.label.includes('unrelated')
          ? { ...add, fields: { description: 'Separate' } }
          : {
              operation: 'update',
              targetUuid: uuid,
              fields: { due: work.observation.label.includes('tuesday') ? '20261201' : '20261203' },
              annotations: [],
            },
        question: null,
      },
    }),
    exact: (work) => ({ match: work.state.summary.includes('unrelated') ? 'different' : 'same' }),
    materialize: (work) => ({
      reason: 'Preserve intent',
      submission: {
        ...work.state.draft,
        question: work.state.summary.includes('unrelated') ? null : 'Tuesday or Thursday?',
        explanation: 'Preserve intent',
      },
    }),
  });
  const submissions = await run();
  expect(submissions).toHaveLength(2);
  const question = submissions.find((submission) => submission.question)!;
  expect(question.change.operation).toBe('update');
  expect(question.expected?.uuid).toBe(uuid);
  expect(question.references).toHaveLength(2);
  expect(
    submissions.find((submission) => !submission.question)!.references.map((ref) => ref.entryId),
  ).toEqual(['entry-2']);
});
it('rejects a valid existing ID that was not on the discovery page', async () => {
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    ...task,
    uuid: `12345678-1234-1234-1234-${String(index).padStart(12, '0')}`,
    description: `Task ${index} ` + 'identity '.repeat(45),
  }));
  vi.mocked(readTaskCatalog).mockResolvedValue(tasks);
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    if (work.catalogue?.[0]?.handle) {
      expect(work.catalogue.some((item: { handle: string }) => item.handle === 'task:99')).toBe(
        false,
      );
      return answerCapture(input, { candidates: ['task:99'] });
    }
    if (work.range)
      return answerCapture(input, {
        complete: true,
        observations: [{ kind: 'accepted', label: 'Comparison', start: 0, end: work.range.end }],
      });
    return answerCapture(input, active);
  });
  await expect(run()).rejects.toThrow('Invalid existing candidate handle');
});
