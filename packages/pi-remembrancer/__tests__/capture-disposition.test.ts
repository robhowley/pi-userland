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
import { runReviewer, type ReviewerInput } from '../extensions/remembrancer/reviewer.js';
import { readTaskCatalog, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import {
  answerCaptureReview,
  captureDisposition,
  captureRecord,
  captureReference,
  type CaptureRecord,
  type CaptureScenario,
} from './fixtures/capture-reviewer.js';

vi.mock('../extensions/remembrancer/reviewer.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/reviewer.js')>()),
  runReviewer: vi.fn(),
}));
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
const record: FindingRecord = { id: 'r', ambiguous: false };
const intent = (change: Proposal['change'] = add, question: string | null = null) => ({
  change,
  question,
  explanation: 'Exact evidence',
});
const disposition = (change: Proposal['change'] = add, question: string | null = null) => ({
  reason: 'Exact evidence',
  submission: intent(change, question),
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
  it('requires the reviewer to preserve an evidence question rather than completing it host-side', () => {
    const state = { ...active, draft: { ...active.draft!, question: 'Tuesday or Thursday?' } };
    expect(() => validateMaterialization(disposition(), record, state)).toThrow(
      'preserve unresolved questions',
    );
    expect(
      validateMaterialization(disposition(add, 'Tuesday or Thursday?'), record, state)?.question,
    ).toBe('Tuesday or Thursday?');
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
          : { operation, targetUuid: uuid, fields: { due: '20261201' }, annotations: [] };
      expect(() =>
        validateMaterialization(
          disposition(change),
          record,
          { ...active, status: 'completed' },
          { expected: snapshot(task) },
        ),
      ).toThrow('requires a question');
    },
  );
  it('validates intent before binding the trusted snapshot', () => {
    const value = disposition();
    Object.assign(value.submission, {
      change: {
        operation: 'update',
        targetUuid: uuid,
        fields: { priority: ['H'] },
        annotations: [],
      },
      expected: { forged: true },
    });
    expect(() =>
      validateMaterialization(value, record, active, { expected: snapshot(task) }),
    ).toThrow('Invalid priority');
  });
});

let dir: string;
let current: CaptureReview;
let rows: Proposal[];
const runner = vi.mocked(runReviewer);
const model = { contextWindow: 32768, maxTokens: 2048 } as NonNullable<ReviewerInput['model']>;
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
  current = new CaptureReview(prepareReview([{ file, sessionId: 'synthetic' }], []), () => {});
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
const taskCandidate = (
  id = uuid,
  judgment: 'same' | 'different' | 'ambiguous' = 'same',
): CaptureRecord['candidates'][number] => ({ kind: 'task', id, judgment });
const proposalCandidate = (id = 'saved'): CaptureRecord['candidates'][number] => ({
  kind: 'proposal',
  id,
  revision: 3,
  judgment: 'same',
});
function scenario(answer: CaptureScenario) {
  runner.mockImplementation((input) => answerCaptureReview(input, answer));
}
// Mechanical single-record builder. Every scenario chooses its matches, state and final intent.
function single(
  options: {
    state?: FoldedFinding;
    kind?: string;
    candidates?: CaptureRecord['candidates'];
    submission?: ReturnType<typeof intent> | null;
    ambiguous?: boolean;
  } = {},
) {
  scenario(async ({ evidence, lookup }) => {
    if (options.candidates?.length) await lookup('remembrancer_tasks', {});
    const reference = captureReference(evidence[0]!);
    return {
      records: [
        captureRecord(
          'r',
          [{ kind: options.kind ?? 'accepted', reference }],
          [{ branchId: reference.branchId, state: options.state ?? active }],
          { candidates: options.candidates ?? [], ambiguous: options.ambiguous ?? false },
        ),
      ],
      dispositions: [
        captureDisposition(
          ['r'],
          options.submission === undefined ? intent() : options.submission,
          'Declared outcome',
        ),
      ],
    };
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-disposition-'));
  rows = [];
  runner.mockReset();
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
  transcript();
  single();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { force: true, recursive: true });
});

it.each([null, 'Which day?'])(
  'preserves the reviewer-finalized unmatched add and question %j',
  async (question) => {
    single({
      state: { ...active, draft: { change: add, question } },
      submission: intent(add, question),
    });
    const submissions = await run();
    expect(submissions).toEqual([
      {
        ...intent(add, question),
        expected: null,
        references: [
          {
            sessionId: 'synthetic',
            branchId: 'entry-0',
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
  'cannot bypass unmatched or ambiguous %s evidence with an active draft',
  async (kind) => {
    transcript([`${kind}:comparison|That comparison`]);
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    single({ kind, candidates: kind === 'accepted' ? [taskCandidate(uuid, 'ambiguous')] : [] });
    await expect(run()).rejects.toThrow('requires a question');
  },
);
it.each([false, true])('does not pick a task by candidate order (reverse=%s)', async (reverse) => {
  const tasks = [task, { ...task, uuid: otherUuid }];
  vi.mocked(readTaskCatalog).mockResolvedValue(reverse ? tasks.reverse() : tasks);
  single({
    candidates: (reverse ? [otherUuid, uuid] : [uuid, otherUuid]).map((id) => taskCandidate(id)),
    submission: intent(add, 'Which comparison?'),
  });
  expect(await run()).toMatchObject([
    { change: add, question: 'Which comparison?', expected: null },
  ]);
});
it.each([false, true])(
  'does not pick a pending row by candidate order (reverse=%s)',
  async (reverse) => {
    rows = [proposal('pending', 'one'), proposal('pending', 'two')];
    if (reverse) rows.reverse();
    single({
      candidates: rows.map((row) => proposalCandidate(row.id)),
      submission: intent(add, 'Which pending interpretation?'),
    });
    const [submission] = await run();
    expect(submission!.id).toBeUndefined();
    expect(submission!.expectedRevision).toBeUndefined();
    expect(rows.map((row) => row.revision)).toEqual([3, 3]);
  },
);
it('never binds a reviewer-selected UUID from an ambiguous match set', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task, { ...task, uuid: otherUuid }]);
  single({
    candidates: [taskCandidate(), taskCandidate(otherUuid)],
    submission: intent({ operation: 'complete', targetUuid: uuid, annotations: [] }, 'Which task?'),
  });
  await expect(run()).rejects.toThrow('not uniquely matched');
});
it.each(['applying', 'uncertain'] as const)(
  'cannot create another pending add for a %s saved add',
  async (state) => {
    rows = [proposal(state)];
    single({ candidates: [proposalCandidate()] });
    await expect(run()).rejects.toThrow('verify-only');
  },
);
it.each(['applying', 'uncertain'] as const)(
  'allows only live verified no-change for a %s saved application',
  async (state) => {
    rows = [{ ...proposal(state), claim: uuid }];
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    single({ candidates: [proposalCandidate(), taskCandidate()], submission: null });
    expect(await run()).toEqual([]);
    expect(() => current.completion([])).not.toThrow();
    expect(rows[0]!.state).toBe(state);
  },
);
it.each(['applying', 'uncertain'] as const)(
  'does not confuse new intent with a verified %s retry',
  async (state) => {
    rows = [{ ...proposal(state), claim: uuid }];
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    single({
      candidates: [proposalCandidate(), taskCandidate()],
      state: {
        ...active,
        draft: {
          change: {
            operation: 'update',
            targetUuid: uuid,
            fields: { priority: 'H' },
            annotations: [],
          },
          question: null,
        },
      },
      submission: null,
    });
    await expect(run()).rejects.toThrow('verify-only');
  },
);
it.each(['applying', 'uncertain'] as const)(
  'does not checkpoint unresolved %s application as completed null',
  async (state) => {
    transcript(['completion:comparison|I sent it.']);
    rows = [proposal(state)];
    single({
      kind: 'completion',
      state: { ...active, status: 'completed' },
      candidates: [proposalCandidate()],
      submission: null,
    });
    await expect(run()).rejects.toThrow('verify-only');
    expect(rows[0]!.state).toBe(state);
  },
);
it.each([false, true])(
  'ambiguous completions cannot silently checkpoint (reverse=%s)',
  async (reverse) => {
    transcript(['completion:comparison|I sent it.']);
    const tasks = [task, { ...task, uuid: otherUuid }];
    vi.mocked(readTaskCatalog).mockResolvedValue(reverse ? tasks.reverse() : tasks);
    single({
      kind: 'completion',
      state: { ...active, status: 'completed' },
      candidates: tasks.map((item) => taskCandidate(item.uuid)),
      submission: null,
    });
    await expect(run()).rejects.toThrow('requires a question');
  },
);
it('does not materialize declared completed evidence as active intent', async () => {
  transcript(['completion:comparison|I sent it.']);
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  single({
    kind: 'completion',
    state: { ...active, status: 'completed' },
    candidates: [taskCandidate()],
    submission: intent({
      operation: 'update',
      targetUuid: uuid,
      fields: { due: '20261201' },
      annotations: [],
    }),
  });
  await expect(run()).rejects.toThrow('requires a question');
});
it('does not revise a pending UUID contradicted by declared evidence intent', async () => {
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
  single({
    candidates: [proposalCandidate()],
    state: {
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
    },
    submission: intent(add, 'Which UUID did you mean?'),
  });
  const [submission] = await run();
  expect(submission!.id).toBeUndefined();
  expect(submission!.expected).toBeNull();
});
it.each(['references', 'id', 'expectedRevision', 'expected'])(
  'rejects reviewer-selected %s in final intent',
  async (field) => {
    scenario(({ evidence }) => ({
      records: [
        captureRecord(
          'r',
          [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
          [{ branchId: evidence[0]!.branchId, state: active }],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['r'],
          Object.assign(intent(), {
            [field]: field === 'references' ? [captureReference(evidence[0]!)] : 'forged',
          }),
          'Forbidden binding',
        ),
      ],
    }));
    await expect(run()).rejects.toThrow('Unknown finalized capture fields');
  },
);
it('retains one declared state for all candidate judgments', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task, { ...task, uuid: otherUuid }]);
  single({
    candidates: [taskCandidate(), taskCandidate(otherUuid)],
    submission: intent(add, 'Which task?'),
  });
  const result = await run();
  expect(result[0]!.question).toBe('Which task?');
  expect(result[0]!.change).toEqual(add);
});
it.each([['same'], { match: 'same' }, null])(
  'rejects non-string declared match %j',
  async (judgment) => {
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    single({ candidates: [{ ...taskCandidate(), judgment: judgment as unknown as string }] });
    await expect(run()).rejects.toThrow('Invalid capture candidate judgment');
  },
);
it('rejects candidate-supplied lifecycle rewrites instead of changing the declared evidence state', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  single({
    candidates: [Object.assign(taskCandidate(), { state: { ...active, status: 'completed' } })],
  });
  await expect(run()).rejects.toThrow('Unknown finalized capture fields');
});
it('accepts explicit untracked completion without manufacturing an ambiguous add', async () => {
  transcript(['completion:comparison|I sent the comparison.']);
  single({ kind: 'completion', state: { ...active, status: 'completed' }, submission: null });
  expect(await run()).toEqual([]);
  expect(() => current.completion([])).not.toThrow();
});
it.each(['pending', 'completed'])(
  'requires observable completion before tracked null (%s)',
  async (status) => {
    transcript(['completion:comparison|I sent it.']);
    vi.mocked(readTaskCatalog).mockResolvedValue([{ ...task, status }]);
    single({
      kind: 'completion',
      state: { ...active, status: 'completed' },
      candidates: [taskCandidate()],
      submission: null,
    });
    if (status === 'completed') expect(await run()).toEqual([]);
    else await expect(run()).rejects.toThrow('Tracked capture');
  },
);
it('keeps an unanchored reference ambiguous even if declared completed', async () => {
  transcript(['reference:it|That one.']);
  single({ kind: 'reference', state: { ...active, status: 'completed' }, submission: null });
  await expect(run()).rejects.toThrow('requires a question');
});
it('binds a matched completed row to its full host snapshot', async () => {
  const completed = {
    ...task,
    status: 'completed',
    annotations: [{ entry: '20261124T010000Z', description: 'Original annotation' }],
  };
  vi.mocked(readTaskCatalog).mockResolvedValue([completed]);
  transcript(['completion:comparison|I sent the comparison.']);
  const change = { operation: 'complete' as const, targetUuid: uuid, annotations: [] };
  single({
    kind: 'completion',
    state: { ...active, status: 'completed' },
    candidates: [taskCandidate()],
    submission: intent(change),
  });
  expect(await run()).toMatchObject([{ change, expected: snapshot(completed) }]);
});
it('rejects active null but accepts a host-proved no-op', async () => {
  single({ state: { ...active, draft: null }, submission: null });
  await expect(run()).rejects.toThrow('Active capture');
  transcript();
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  single({ candidates: [taskCandidate()], submission: null });
  expect(await run()).toEqual([]);
});

it.each([false, true])(
  'validates reviewer-grouped compatible changes and unrelated evidence (reverse=%s)',
  async (reverse) => {
    const texts = [
      'accepted:due|Set due',
      'accepted:project|Set project',
      'accepted:unrelated|Separate task',
    ];
    transcript(reverse ? [...texts].reverse() : texts);
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    scenario(async ({ evidence, lookup }) => {
      await lookup('remembrancer_tasks', {});
      const records = evidence.map((entry) => {
        const unrelated = entry.text.includes('unrelated');
        const change: Proposal['change'] = unrelated
          ? { ...add, fields: { description: 'Separate task' } }
          : {
              operation: 'update',
              targetUuid: uuid,
              fields: entry.text.includes('due') ? { due: '20261201' } : { project: 'Review' },
              annotations: [],
            };
        return captureRecord(
          unrelated ? 'separate' : entry.text.includes('due') ? 'due' : 'project',
          [{ kind: 'accepted', reference: captureReference(entry) }],
          [{ branchId: entry.branchId, state: { ...active, draft: { change, question: null } } }],
          { candidates: [taskCandidate(uuid, unrelated ? 'different' : 'same')] },
        );
      });
      return {
        records,
        dispositions: [
          captureDisposition(
            ['due', 'project'],
            intent({
              operation: 'update',
              targetUuid: uuid,
              fields: { due: '20261201', project: 'Review' },
              annotations: [],
            }),
            'Both changes',
          ),
          captureDisposition(
            ['separate'],
            intent({ ...add, fields: { description: 'Separate task' } }),
            'Separate',
          ),
        ],
      };
    });
    const submissions = await run();
    expect(submissions).toHaveLength(2);
    const update = submissions.find((item) => item.change.operation === 'update')!;
    expect(update.expected).toEqual(snapshot(task));
    expect(new Set(update.references.map((ref) => ref.quote))).toEqual(new Set(texts.slice(0, 2)));
    expect(
      submissions
        .find((item) => item.change.operation === 'add')!
        .references.map((ref) => ref.quote),
    ).toEqual([texts[2]]);
  },
);
it.each(['fields', 'annotations'])(
  'does not drop compatible requested %s while consolidating',
  async (omitted) => {
    transcript(['accepted:due|Set due', 'accepted:project|Set project']);
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    scenario(async ({ evidence, lookup }) => {
      await lookup('remembrancer_tasks', {});
      return {
        records: evidence.map((entry, index) =>
          captureRecord(
            String(index),
            [{ kind: 'accepted', reference: captureReference(entry) }],
            [
              {
                branchId: entry.branchId,
                state: {
                  ...active,
                  draft: {
                    change: {
                      operation: 'update',
                      targetUuid: uuid,
                      fields: index ? { project: 'Review' } : { due: '20261201' },
                      annotations: index ? [] : ['Keep this note'],
                    },
                    question: null,
                  },
                },
              },
            ],
            { candidates: [taskCandidate()] },
          ),
        ),
        dispositions: [
          captureDisposition(
            ['0', '1'],
            intent({
              operation: 'update',
              targetUuid: uuid,
              fields:
                omitted === 'fields' ? { due: '20261201' } : { due: '20261201', project: 'Review' },
              annotations: omitted === 'annotations' ? [] : ['Keep this note'],
            }),
            'Incomplete consolidation',
          ),
        ],
      };
    });
    await expect(run()).rejects.toThrow(`Consolidation dropped requested ${omitted}`);
  },
);
it('groups two pending confirmations into one revision, preserving its question and both sources', async () => {
  transcript(['accepted:first|Comparison', 'accepted:second|Same comparison']);
  rows = [{ ...proposal(), question: 'Keep the edited plan?' }];
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_proposals', {});
    return {
      records: evidence.map((entry, index) =>
        captureRecord(
          String(index),
          [{ kind: 'accepted', reference: captureReference(entry) }],
          [{ branchId: entry.branchId, state: active }],
          { candidates: [proposalCandidate()] },
        ),
      ),
      dispositions: [
        captureDisposition(
          ['0', '1'],
          intent(add, 'Keep the edited plan?'),
          'Same pending obligation',
        ),
      ],
    };
  });
  const submissions = await run();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    id: 'saved',
    expectedRevision: 3,
    question: 'Keep the edited plan?',
  });
  expect(submissions[0]!.references.map((ref) => ref.entryId)).toEqual(['entry-0', 'entry-1']);
  expect(rows[0]!.revision).toBe(3);
});
it.each(['applied', 'already_satisfied'] as const)(
  'leaves matched %s add unresolved without its live verified UUID',
  async (state) => {
    rows = [{ ...proposal(state), result: { state, verified: snapshot(task), error: null } }];
    expect(captureIsSatisfied(active, resolveCaptureMatches([], rows))).toBe(false);
    single({ candidates: [proposalCandidate()], submission: null });
    await expect(run()).rejects.toThrow('no live task; capture unresolved');
  },
);
it.each([false, true])(
  'uses the live renamed task behind a declared applied match (satisfied=%s)',
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
    single({
      candidates: [proposalCandidate(), taskCandidate(uuid, 'different')],
      state: {
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
      },
      submission: null,
    });
    if (satisfied) expect(await run()).toEqual([]);
    else await expect(run()).rejects.toThrow('Tracked capture requires a proposal');
    expect(readTaskCatalog).toHaveBeenCalledOnce();
  },
);
it.each(['third source', 'truncated quote', 'unrelated'] as const)(
  'lets the reviewer inspect exact saved source clues before declaring a match (%s)',
  async (which) => {
    const background = 'Routine project background. '.repeat(80);
    const thirdQuote =
      which === 'third source'
        ? `Comparison promised for Maya. ${background}`
        : which === 'truncated quote'
          ? `${background} Comparison promised for Maya.`
          : `Maintain payroll. ${background}`;
    rows = [
      {
        ...proposal(),
        draft: {
          change: { ...add, fields: { description: 'Assemble launch briefing' } },
          expected: null,
          question: null,
        },
        sources: Array.from({ length: 5 }, (_, index) => ({
          sessionId: 'saved-session',
          branchId: 'saved-branch',
          entryId: `saved-${index}`,
          editId: null,
          file: '/never-read.jsonl',
          role: 'user',
          timestamp: '',
          locator: `saved-${index}`,
          offset: 0,
          quote: index === 2 ? thirdQuote : background,
        })),
      },
    ];
    scenario(async ({ evidence, lookup }) => {
      await lookup('remembrancer_proposals', {});
      let request: object | null = { action: 'evidence', id: 'saved', revision: 3 };
      const quotes = new Map<number, string>();
      while (request) {
        const page: { entries: { index: number; quote: string }[]; next: object | null } =
          await lookup('remembrancer_proposals', request);
        for (const entry of page.entries)
          quotes.set(entry.index, (quotes.get(entry.index) ?? '') + entry.quote);
        request = page.next;
      }
      expect(quotes.get(2)).toBe(thirdQuote);
      const same = quotes.get(2)!.includes('Comparison promised');
      const change = same ? rows[0]!.draft!.change : add;
      return {
        records: [
          captureRecord(
            'r',
            [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
            [{ branchId: evidence[0]!.branchId, state: active }],
            { candidates: [{ ...proposalCandidate(), judgment: same ? 'same' : 'different' }] },
          ),
        ],
        dispositions: [
          captureDisposition(['r'], intent(change), 'Reviewer inspected saved quotes'),
        ],
      };
    });
    const submissions = await run();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.id).toBe(which === 'unrelated' ? undefined : 'saved');
  },
);
it('matches an applied add by verified UUID after a task rename', async () => {
  const renamed = { ...task, description: 'Renamed comparison' };
  rows = [
    { ...proposal('applied'), result: { state: 'applied', verified: snapshot(task), error: null } },
  ];
  vi.mocked(readTaskCatalog).mockResolvedValue([renamed]);
  const change = {
    operation: 'update' as const,
    targetUuid: uuid,
    fields: { project: 'Review' },
    annotations: [],
  };
  single({
    candidates: [proposalCandidate()],
    state: { ...active, draft: { change, question: null } },
    submission: intent(change),
  });
  const [submission] = await run();
  expect(submission!.expected).toEqual(snapshot(renamed));
  expect(submission!.id).toBeUndefined();
  expect(rows[0]!.state).toBe('applied');
});
it.each([false, true])(
  'does not persist a winner for conflicting same-target records (reverse=%s)',
  async (reverse) => {
    transcript(
      reverse
        ? ['accepted:thursday|Thursday', 'accepted:tuesday|Tuesday']
        : ['accepted:tuesday|Tuesday', 'accepted:thursday|Thursday'],
    );
    vi.mocked(readTaskCatalog).mockResolvedValue([task]);
    scenario(async ({ evidence, lookup }) => {
      await lookup('remembrancer_tasks', {});
      return {
        records: evidence.map((entry, index) =>
          captureRecord(
            String(index),
            [{ kind: 'accepted', reference: captureReference(entry) }],
            [
              {
                branchId: entry.branchId,
                state: {
                  ...active,
                  draft: {
                    change: {
                      operation: 'update',
                      targetUuid: uuid,
                      fields: { due: entry.text.includes('tuesday') ? '20261201' : '20261203' },
                      annotations: [],
                    },
                    question: null,
                  },
                },
              },
            ],
            { candidates: [taskCandidate()] },
          ),
        ),
        dispositions: [
          captureDisposition(
            ['0', '1'],
            intent({
              operation: 'update',
              targetUuid: uuid,
              fields: { due: '20261201' },
              annotations: [],
            }),
            'Guess',
          ),
        ],
      };
    });
    await expect(run()).rejects.toThrow('requires a question');
  },
);
it('keeps unrelated proposals when conflicting edits use a question on the known target', async () => {
  transcript([
    'accepted:tuesday|Tuesday',
    'accepted:thursday|Thursday',
    'accepted:unrelated|Separate',
  ]);
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_tasks', {});
    return {
      records: evidence.map((entry, index) =>
        captureRecord(
          String(index),
          [{ kind: 'accepted', reference: captureReference(entry) }],
          [
            {
              branchId: entry.branchId,
              state: {
                ...active,
                draft: {
                  change:
                    index === 2
                      ? add
                      : {
                          operation: 'update',
                          targetUuid: uuid,
                          fields: { due: index ? '20261203' : '20261201' },
                          annotations: [],
                        },
                  question: null,
                },
              },
            },
          ],
          { candidates: index === 2 ? [] : [taskCandidate()] },
        ),
      ),
      dispositions: [
        captureDisposition(
          ['0', '1'],
          intent(
            { operation: 'update', targetUuid: uuid, fields: { due: '20261201' }, annotations: [] },
            'Tuesday or Thursday?',
          ),
          'Conflicting dates',
        ),
        captureDisposition(['2'], intent(), 'Separate'),
      ],
    };
  });
  const submissions = await run();
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toMatchObject({
    change: { operation: 'update', targetUuid: uuid },
    expected: { uuid },
    question: 'Tuesday or Thursday?',
  });
  expect(submissions[0]!.references).toHaveLength(2);
  expect(submissions[1]!.references.map((ref) => ref.entryId)).toEqual(['entry-2']);
});
it('accepts a retained task selected outside a returned summary page, not an invented handle', async () => {
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    ...task,
    uuid: `12345678-1234-1234-1234-${String(index).padStart(12, '0')}`,
    description: `Task ${index}`,
  }));
  vi.mocked(readTaskCatalog).mockResolvedValue(tasks);
  const change = {
    operation: 'update' as const,
    targetUuid: tasks[99]!.uuid,
    fields: { project: 'Review' },
    annotations: [],
  };
  scenario(async ({ evidence, lookup }) => {
    const list = await lookup<{ tasks: { uuid: string }[] }>('remembrancer_tasks', {});
    expect(list.tasks.some((item) => item.uuid === tasks[99]!.uuid)).toBe(false);
    const detail = await lookup<{ json: string }>('remembrancer_tasks', { uuid: tasks[99]!.uuid });
    expect(JSON.parse(detail.json)).toEqual(tasks[99]);
    return {
      records: [
        captureRecord(
          'r',
          [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
          [{ branchId: evidence[0]!.branchId, state: active }],
          { candidates: [taskCandidate(tasks[99]!.uuid)] },
        ),
      ],
      dispositions: [captureDisposition(['r'], intent(change), 'Explicit exact lookup')],
    };
  });
  expect(await run()).toMatchObject([{ change, expected: snapshot(tasks[99]!) }]);
});
it.each([null, 'Reopen this obligation?'])(
  'requires a reviewer question to reopen dismissed intent (%j)',
  async (question) => {
    rows = [proposal('dismissed')];
    single({ candidates: [proposalCandidate()], submission: intent(add, question) });
    if (question) expect(await run()).toMatchObject([{ change: add, question }]);
    else
      await expect(run()).rejects.toThrow('Reopening a dismissed obligation requires a question');
  },
);
it('does not treat a dismissed row as verified satisfaction', async () => {
  rows = [proposal('dismissed')];
  single({ candidates: [proposalCandidate()], submission: null });
  await expect(run()).rejects.toThrow(/Tracked capture|Dismissed proposal/);
});
it('cannot discard a saved pending proposal with a null disposition', async () => {
  rows = [proposal()];
  single({ candidates: [proposalCandidate()], submission: null });
  await expect(run()).rejects.toThrow('Tracked capture requires a proposal');
});
it.each(['operation', 'field', 'uuid'])(
  'rejects unauthorized proposal %s syntax',
  async (invalid) => {
    const submission = { ...intent(), change: structuredClone(add) };
    if (invalid === 'operation')
      Object.assign(submission.change, { operation: 'delete', targetUuid: uuid });
    else if (invalid === 'field') Object.assign(submission.change.fields, { status: 'deleted' });
    else
      Object.assign(submission, {
        change: { operation: 'complete', targetUuid: '12345678', annotations: [] },
      });
    single({ submission });
    await expect(run()).rejects.toThrow(
      invalid === 'uuid'
        ? 'Expected full task UUID'
        : invalid === 'operation'
          ? 'Invalid operation'
          : 'Invalid proposal fields',
    );
  },
);
it.each(['unknown task', 'stale proposal revision'])('rejects a declared %s', async (which) => {
  rows = [proposal()];
  single({
    candidates:
      which === 'unknown task' ? [taskCandidate()] : [{ ...proposalCandidate(), revision: 2 }],
  });
  await expect(run()).rejects.toThrow(
    which === 'unknown task'
      ? 'Unknown retained task candidate'
      : 'Missing or stale retained proposal candidate',
  );
});
it.each(['missing branch', 'repeated branch', 'wrong branch'])(
  'requires exactly one state per observed branch (%s)',
  async (which) => {
    scenario(({ evidence }) => {
      const reference = captureReference(evidence[0]!);
      const branch = { branchId: reference.branchId, state: active };
      return {
        records: [
          captureRecord(
            'r',
            [{ kind: 'accepted', reference }],
            which === 'missing branch'
              ? []
              : which === 'repeated branch'
                ? [branch, branch]
                : [{ ...branch, branchId: 'invented' }],
          ),
        ],
        dispositions: [captureDisposition(['r'], intent(), 'Invalid branch declaration')],
      };
    });
    await expect(run()).rejects.toThrow(
      /branch-specific capture state|exactly one observed branch/,
    );
  },
);
it('rejects separate dispositions for records declaring the same definite target', async () => {
  transcript(['accepted:first|Comparison', 'accepted:second|Same comparison']);
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_tasks', {});
    return {
      records: evidence.map((entry, index) =>
        captureRecord(
          String(index),
          [{ kind: 'accepted', reference: captureReference(entry) }],
          [{ branchId: entry.branchId, state: active }],
          { candidates: [taskCandidate()] },
        ),
      ),
      dispositions: [
        captureDisposition(['0'], null, 'Already satisfied'),
        captureDisposition(['1'], null, 'Already satisfied'),
      ],
    };
  });
  await expect(run()).rejects.toThrow('Declared disposition does not match definite identities');
});
it.each(['pending', 'dismissed', 'applying', 'uncertain'] as const)(
  'accepts no reported commitments without claiming exhaustive discovery or matching (%s saved)',
  async (savedState) => {
    rows = [proposal(savedState)];
    const list = vi.spyOn(db, 'proposals');
    scenario(() => ({ records: [], dispositions: [] }));
    expect(await run()).toEqual([]);
    expect(readTaskCatalog).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(() => current.completion([])).not.toThrow();
  },
);
