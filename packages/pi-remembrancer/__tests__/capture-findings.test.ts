import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import { runReviewer, type ReviewerInput } from '../extensions/remembrancer/reviewer.js';
import { CaptureRetryableError } from '../extensions/remembrancer/capture-jobs.js';
import { readTaskCatalog, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';
import type { FoldedFinding } from '../extensions/remembrancer/review-findings.js';
import {
  answerCaptureReview,
  captureDisposition,
  captureRecord,
  captureReference,
  reviewerPaths,
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
let dir: string;
let current: CaptureReview;
let db: CheckpointStore;
let rows: Proposal[];
let generation: number;
const runner = vi.mocked(runReviewer);
const model = { contextWindow: 32768, maxTokens: 2048 } as NonNullable<ReviewerInput['model']>;
const uuid = '12345678-1234-1234-1234-123456789abc';
const add = {
  operation: 'add' as const,
  fields: { description: 'Send the comparison' },
  annotations: [],
};
const active: FoldedFinding = {
  summary: 'Comparison',
  status: 'active',
  draft: { change: add, question: null },
};
const intent = (change: Proposal['change'] = add, question: string | null = null) => ({
  change,
  question,
  explanation: 'Reviewer-finalized intent',
});
const run = () =>
  reviewPreparedCapture(current, db, { cwd: dir, sessionId: 'session', model }, () => {});
function prepare(texts = ['I will send the comparison.']) {
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      ...texts.map((content, index) => ({
        type: 'message',
        id: index ? `m${index}` : 'intent',
        parentId: index ? (index === 1 ? 'intent' : `m${index - 1}`) : null,
        message: { role: 'user', content },
      })),
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  current = new CaptureReview(prepareReview([{ file, sessionId: 'session' }], []), () => {});
}
function scenario(answer: CaptureScenario) {
  runner.mockImplementation((input) => answerCaptureReview(input, answer));
}
function one(
  evidence: Parameters<CaptureScenario>[0]['evidence'],
  candidates: CaptureRecord['candidates'] = [],
  state = active,
) {
  return captureRecord(
    'comparison',
    [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
    [{ branchId: evidence[0]!.branchId, state }],
    { candidates },
  );
}
function saved(): Proposal {
  return {
    id: 'saved',
    revision: 3,
    state: 'pending',
    change: { ...add, fields: { description: 'Old automatic interpretation' } },
    expected: null,
    question: null,
    draft: {
      change: { ...add, fields: { description: 'Effective edited draft' } },
      expected: null,
      question: 'Keep my draft?',
    },
    explanation: '😀\\"\n'.repeat(15000),
    sources: [
      {
        sessionId: 'old',
        branchId: 'branch',
        entryId: 'entry',
        editId: null,
        file: '/frozen/old.jsonl',
        role: 'user',
        timestamp: '',
        locator: 'old/branch/entry',
        offset: 12,
        quote: '🛠️\\"\n'.repeat(15000),
      },
    ],
    result: null,
    claim: null,
    createdAt: '',
    updatedAt: '',
  };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-findings-'));
  prepare();
  rows = [];
  generation = 0;
  db = {
    contextGeneration: () => generation,
    proposals: (_state: unknown, offset: number, limit: number) =>
      rows.slice(offset, offset + limit),
    proposal: (id: string) => rows.find((row) => row.id === id),
  } as CheckpointStore;
  runner.mockReset();
  scenario(({ evidence }) => ({
    records: [one(evidence)],
    dispositions: [captureDisposition(['comparison'], intent(), 'Accepted obligation')],
  }));
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it('allows an agent-declared unrelated task despite large retained metadata and annotations', async () => {
  const unrelated = {
    uuid,
    status: 'pending',
    description: 'Unrelated maintenance',
    custom: 'metadata '.repeat(20000),
    annotations: [{ entry: '20260101T000000Z', description: 'Supporting detail '.repeat(2000) }],
  };
  vi.mocked(readTaskCatalog).mockResolvedValue([unrelated]);
  scenario(async ({ evidence, lookup }) => {
    const page = await lookup<{ tasks: { uuid: string; description: string }[] }>(
      'remembrancer_tasks',
      { query: 'maintenance' },
    );
    expect(page.tasks).toEqual([
      { uuid, status: 'pending', description: 'Unrelated maintenance', truncated: false },
    ]);
    return {
      records: [one(evidence, [{ kind: 'task', id: uuid, judgment: 'different' }])],
      dispositions: [captureDisposition(['comparison'], intent(), 'Maintenance is unrelated')],
    };
  });
  expect(await run()).toHaveLength(1);
});
it('exposes verified UUID and exact old sources to match an applied add after task rename', async () => {
  const task = { uuid, status: 'pending', description: 'Renamed deliverable' };
  const old = saved();
  rows = [
    {
      ...old,
      draft: null,
      state: 'applied',
      claim: uuid,
      result: { state: 'applied', verified: snapshot(task), error: null },
      sources: [
        { ...old.sources[0]!, quote: 'I will send the comparison. ' + 'support '.repeat(1500) },
      ],
    },
  ];
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  const change = {
    operation: 'update' as const,
    targetUuid: uuid,
    fields: { priority: 'H' as const },
    annotations: [],
  };
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_proposals', {});
    let request: object | null = { action: 'detail', id: 'saved', revision: 3 };
    let json = '';
    while (request) {
      const page: { json: string; next: object | null } = await lookup(
        'remembrancer_proposals',
        request,
      );
      json += page.json;
      request = page.next;
    }
    expect(JSON.parse(json).result.verified.uuid).toBe(uuid);
    const sources = await lookup<{ entries: { quote: string }[] }>('remembrancer_proposals', {
      action: 'evidence',
      id: 'saved',
      revision: 3,
    });
    expect(sources.entries[0]!.quote).toContain('I will send the comparison.');
    const detail = await lookup<{ json: string }>('remembrancer_tasks', { uuid });
    expect(JSON.parse(detail.json)).toEqual(task);
    return {
      records: [
        one(
          evidence,
          [
            { kind: 'task', id: uuid, judgment: 'same' },
            { kind: 'proposal', id: 'saved', revision: 3, judgment: 'same' },
          ],
          { ...active, draft: { change, question: null } },
        ),
      ],
      dispositions: [captureDisposition(['comparison'], intent(change), 'Verified renamed task')],
    };
  });
  const submissions = await run();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ change, expected: snapshot(task) });
  expect(submissions[0]).not.toHaveProperty('id');
});
it('rechecks generation even when the reviewer declares no matching proposal', async () => {
  rows = [saved()];
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_proposals', {});
    generation++;
    return {
      records: [
        one(evidence, [{ kind: 'proposal', id: 'saved', revision: 3, judgment: 'different' }]),
      ],
      dispositions: [captureDisposition(['comparison'], intent(), 'Unrelated')],
    };
  });
  await expect(run()).rejects.toBeInstanceOf(CaptureRetryableError);
});
it.each(['plausible', 'long label'])(
  'lets the reviewer read exact effective drafts and evidence (%s)',
  async (identity) => {
    rows = [saved()];
    rows[0]!.draft!.change = {
      ...add,
      fields: {
        description: 'Send the comparison' + (identity === 'long label' ? ' '.repeat(3000) : ''),
      },
    };
    scenario(async ({ evidence, lookup }) => {
      const list = await lookup<{ proposals: { hasDraft: boolean; labelTruncated: boolean }[] }>(
        'remembrancer_proposals',
        {},
      );
      expect(list.proposals[0]!.hasDraft).toBe(true);
      expect(list.proposals[0]!.labelTruncated).toBe(identity === 'long label');
      let request: object | null = { action: 'detail', id: 'saved', revision: 3 };
      let json = '';
      let detailPages = 0;
      while (request) {
        const page: { json: string; next: object | null } = await lookup(
          'remembrancer_proposals',
          request,
        );
        expect(page.json).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        json += page.json;
        request = page.next;
        detailPages++;
      }
      const detail = JSON.parse(json) as Proposal;
      expect(detail.explanation).toBe(rows[0]!.explanation);
      expect(detail.draft).toEqual(rows[0]!.draft);
      expect(detailPages).toBeGreaterThan(1);
      request = { action: 'evidence', id: 'saved', revision: 3 };
      let quote = '';
      while (request) {
        const page: {
          entries: { quote: string; quotePosition: number; offset: number }[];
          next: object | null;
        } = await lookup('remembrancer_proposals', request);
        for (const entry of page.entries) {
          expect(entry.quotePosition).toBe(quote.length);
          expect(entry.offset).toBe(12);
          quote += entry.quote;
        }
        request = page.next;
      }
      expect(quote).toBe(rows[0]!.sources[0]!.quote);
      return {
        records: [
          one(evidence, [{ kind: 'proposal', id: 'saved', revision: 3, judgment: 'same' }]),
        ],
        dispositions: [
          captureDisposition(
            ['comparison'],
            intent(detail.draft!.change, detail.draft!.question),
            'Preserve the exact edited draft',
          ),
        ],
      };
    });
    const submissions = await run();
    expect(submissions).toMatchObject([
      {
        id: 'saved',
        expectedRevision: 3,
        change: rows[0]!.draft!.change,
        question: 'Keep my draft?',
      },
    ]);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]![0].instruction).not.toContain(rows[0]!.explanation);
  },
);
it('lets the reviewer explicitly page saved proposals before declaring no match', async () => {
  rows = Array.from({ length: 45 }, (_, index) => ({
    ...saved(),
    id: `saved-${index}`,
    explanation: 'short',
    sources: [],
    draft: null,
  }));
  const list = vi.spyOn(db, 'proposals');
  const examined = new Set<string>();
  scenario(async ({ evidence, lookup }) => {
    let offset: number | null = 0;
    do {
      const page: { proposals: { id: string }[]; nextOffset: number | null } = await lookup(
        'remembrancer_proposals',
        { offset },
      );
      page.proposals.forEach((item) => examined.add(item.id));
      offset = page.nextOffset;
    } while (offset !== null);
    return {
      records: [one(evidence)],
      dispositions: [
        captureDisposition(['comparison'], intent(), 'Reviewer found no existing match'),
      ],
    };
  });
  expect(await run()).toHaveLength(1);
  expect(examined.size).toBe(45);
  expect(list.mock.calls).toEqual([[undefined, 0, 100]]);
});
it.each(['missing', 'stale', 'other proposal'])(
  'aborts a %s change during explicit candidate reads',
  async (change) => {
    rows = [saved()];
    scenario(async ({ lookup }) => {
      await lookup('remembrancer_proposals', {});
      if (change === 'missing') rows = [];
      else if (change === 'stale') rows[0] = { ...rows[0]!, revision: 4 };
      else generation++;
      await lookup('remembrancer_proposals', { action: 'detail', id: 'saved', revision: 3 });
      throw new Error('Changed candidate was accepted');
    });
    await expect(run()).rejects.toThrow(
      change === 'missing'
        ? 'Missing proposal'
        : change === 'stale'
          ? 'Stale proposal'
          : 'context changed',
    );
  },
);
it('aborts drifting typed enumeration before returning any matching page', async () => {
  const original = { ...saved(), explanation: 'short', sources: [] };
  rows = Array.from({ length: 205 }, (_, index) => ({ ...original, id: `saved-${index}` }));
  const list = db.proposals;
  vi.spyOn(db, 'proposals').mockImplementation((state, offset, limit) => {
    if (offset === 100) {
      rows = rows.slice(1);
      generation++;
    }
    return list(state, offset, limit);
  });
  scenario(async ({ lookup }) => {
    await lookup('remembrancer_proposals', {});
    throw new Error('Drifting view was accepted');
  });
  await expect(run()).rejects.toBeInstanceOf(CaptureRetryableError);
});
it('validates the reviewer submission before returning staged proposals', async () => {
  rows = [saved()];
  const completion = vi.spyOn(current, 'completion');
  const staged = await run();
  expect(completion).toHaveBeenCalledOnce();
  expect(() => current.completion(staged)).not.toThrow();
});
it('uses one retained task export for list/detail reads and host-validates the exact target', async () => {
  const task = { uuid, status: 'pending', description: 'Comparison' };
  prepare(['I sent the comparison.']);
  const completed = { ...task, uuid: '12345678-1234-1234-1234-123456789abd', status: 'completed' };
  vi.mocked(readTaskCatalog).mockResolvedValue([completed, task]);
  const change = { operation: 'complete' as const, targetUuid: uuid, annotations: [] };
  scenario(async ({ evidence, lookup }) => {
    const list = await lookup<{ tasks: { uuid: string }[] }>('remembrancer_tasks', {
      query: 'comparison',
    });
    for (const item of list.tasks) await lookup('remembrancer_tasks', { uuid: item.uuid });
    return {
      records: [
        captureRecord(
          'comparison',
          [{ kind: 'completion', reference: captureReference(evidence[0]!) }],
          [
            {
              branchId: evidence[0]!.branchId,
              state: { ...active, status: 'completed', draft: { change, question: null } },
            },
          ],
          {
            candidates: [
              { kind: 'task', id: completed.uuid, judgment: 'different' },
              { kind: 'task', id: uuid, judgment: 'same' },
            ],
          },
        ),
      ],
      dispositions: [captureDisposition(['comparison'], intent(change), 'Completed existing task')],
    };
  });
  expect(await run()).toMatchObject([{ change, expected: snapshot(task) }]);
  expect(readTaskCatalog).toHaveBeenCalledTimes(1);
});
it.each([
  ['missing submission', 'Reviewer did not submit a result'],
  ['invalid range', 'Reference does not match frozen eligible evidence'],
  ['invalid kind', 'Invalid capture observation kind'],
  ['unmatched target', 'not uniquely matched'],
  ['runner budget', 'Reviewer context budget exhausted'],
])('rejects %s without returning a staged disposition', async (failure, error) => {
  if (failure === 'runner budget') runner.mockRejectedValue(new Error(error));
  else if (failure === 'missing submission')
    runner.mockImplementation(async (input) => {
      const paths = reviewerPaths(input.instruction);
      const tool = input.tools.find((tool) => tool.name === 'remembrancer_read')!;
      for (const path of [paths.skill, paths.review]) {
        const result = await tool.execute(
          path,
          { path },
          undefined,
          undefined,
          {} as Parameters<typeof tool.execute>[4],
        );
        input.acceptToolResult?.(result);
      }
    });
  else
    scenario(({ evidence }) => {
      const declaration = one(evidence);
      if (failure === 'invalid range')
        declaration.observations[0]!.reference.quote += 'invented suffix';
      if (failure === 'invalid kind') declaration.observations[0]!.kind = 'invented';
      return {
        records: [declaration],
        dispositions: [
          captureDisposition(
            ['comparison'],
            failure === 'unmatched target'
              ? intent({
                  operation: 'update',
                  targetUuid: uuid,
                  fields: { priority: 'H' },
                  annotations: [],
                })
              : intent(),
            'Invalid submission',
          ),
        ],
      };
    });
  await expect(run()).rejects.toThrow(error);
  if (failure === 'runner budget')
    expect(() => current.completion([])).toThrow('Read all evidence pages');
});
it.each(['correction', 'completion', 'ambiguous'])(
  'retains both founders and all branch references after a reviewer-declared %s bridge',
  async (outcome) => {
    const messages = [
      'accepted:alpha|Send the comparison Friday',
      'accepted:beta|Send Maya the report Friday',
      'accepted:bridge|Those are the same delivery',
      'correction:bridge|Send Maya the comparison Monday',
      ...(outcome === 'completion' ? ['completion:bridge|Sent it'] : []),
    ];
    const file = join(dir, 'bridge.jsonl');
    writeFileSync(
      file,
      [
        { type: 'session', id: 'session', cwd: dir },
        ...messages.map((content, index) => ({
          type: 'message',
          id: `m${index}`,
          parentId: index ? `m${index - 1}` : null,
          message: { role: 'user', content },
        })),
        ...['left', 'right'].map((id) => ({
          type: 'message',
          id,
          parentId: `m${messages.length - 1}`,
          message: { role: 'assistant', content: 'Context only' },
        })),
      ]
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n',
    );
    current = new CaptureReview(prepareReview([{ file, sessionId: 'session' }], []), () => {});
    scenario(({ evidence }) => {
      const relevant = evidence.filter((entry) => entry.entryId.startsWith('m'));
      expect(relevant).toHaveLength(messages.length * 2);
      if (outcome === 'ambiguous') {
        const groups = [['m0'], ['m1'], ['m2', 'm3']];
        return {
          records: groups.map((ids, index) =>
            captureRecord(
              String(index),
              relevant
                .filter((entry) => ids.includes(entry.entryId))
                .map((entry) => ({
                  kind: entry.text.split(':')[0]!,
                  reference: captureReference(entry),
                })),
              ['left', 'right'].map((branchId) => ({ branchId, state: active })),
              { ambiguous: true },
            ),
          ),
          dispositions: groups.map((_, index) =>
            captureDisposition(
              [String(index)],
              intent(add, 'Are these the same delivery?'),
              'Unresolved bridge',
            ),
          ),
        };
      }
      const change = { ...add, fields: { description: 'Send Maya the comparison Monday' } };
      return {
        records: [
          captureRecord(
            'delivery',
            relevant.map((entry) => ({
              kind: entry.text.split(':')[0]!,
              reference: captureReference(entry),
            })),
            ['left', 'right'].map((branchId) => ({
              branchId,
              state: {
                ...active,
                status: outcome === 'completion' ? 'completed' : 'active',
                draft: { change, question: null },
              },
            })),
          ),
        ],
        dispositions: [
          captureDisposition(
            ['delivery'],
            outcome === 'completion' ? null : intent(change),
            'Reviewer resolved both founders',
          ),
        ],
      };
    });
    const submissions = await run();
    expect(() => current.completion(submissions)).not.toThrow();
    if (outcome === 'completion') expect(submissions).toEqual([]);
    else if (outcome === 'ambiguous') {
      expect(submissions).toHaveLength(3);
      expect(submissions.every((item) => !!item.question)).toBe(true);
      expect(submissions.flatMap((item) => item.references)).toHaveLength(8);
    } else {
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.question).toBeNull();
      expect(submissions[0]!.references.map((ref) => ref.entryId).sort()).toEqual([
        'm0',
        'm0',
        'm1',
        'm1',
        'm2',
        'm2',
        'm3',
        'm3',
      ]);
    }
  },
);
it('keeps exact earlier correction text available in the continuing evidence history', async () => {
  prepare(['accepted:alpha|Friday', 'correction:alpha|Monday', 'progress:alpha|Waiting on Maya']);
  scenario(({ evidence }) => {
    expect(evidence.map((entry) => entry.text)).toEqual([
      'accepted:alpha|Friday',
      'correction:alpha|Monday',
      'progress:alpha|Waiting on Maya',
    ]);
    const change = { ...add, fields: { description: 'Send the comparison Monday' } };
    return {
      records: [
        captureRecord(
          'comparison',
          evidence.map((entry) => ({
            kind: entry.text.split(':')[0]!,
            reference: captureReference(entry),
          })),
          [
            {
              branchId: evidence[0]!.branchId,
              state: { ...active, draft: { change, question: null } },
            },
          ],
        ),
      ],
      dispositions: [
        captureDisposition(['comparison'], intent(change), 'Earlier correction retained'),
      ],
    };
  });
  expect((await run())[0]!.references).toHaveLength(3);
});
it.each([
  ['skipped page', 'next evidence page in order'],
  ['unaccepted page', 'Read and accept the complete installed skill first'],
  ['invented path', 'not an allowed'],
  ['invalid context', 'Selected evidence'],
  ['failure after page', 'Provider failure after page'],
])('does not finish after %s', async (failure, error) => {
  prepare(['😀'.repeat(40000)]);
  runner.mockImplementation(async (input) => {
    const paths = reviewerPaths(input.instruction);
    const read = input.tools.find((tool) => tool.name === 'remembrancer_read')!;
    const execute = (path: string, page = 0) =>
      read.execute(
        'read',
        { path, page },
        undefined,
        undefined,
        {} as Parameters<typeof read.execute>[4],
      );
    const skill = await execute(paths.skill);
    if (failure !== 'unaccepted page') input.acceptToolResult?.(skill);
    if (failure === 'skipped page') await execute(paths.review, 1);
    else if (failure === 'invented path') await execute(join(dir, 'invented'));
    else if (failure === 'invalid context') {
      const context = input.tools.find((tool) => tool.name === 'remembrancer_context')!;
      await context.execute(
        'context',
        { selected: { sessionId: 'other', branchId: 'other', entryId: 'other', editId: null } },
        undefined,
        undefined,
        {} as Parameters<typeof context.execute>[4],
      );
    } else {
      const result = await execute(paths.review);
      input.acceptToolResult?.(result);
      throw new Error('Provider failure after page');
    }
  });
  await expect(run()).rejects.toThrow(error);
  expect(() => current.completion([])).toThrow('Read all evidence pages');
});
it('resolves distant pronouns in each frozen branch without promoting supporting context to evidence', async () => {
  const file = join(dir, 'context.jsonl');
  const descriptions = ['Send Maya the comparison.', 'Send Leon the route.'];
  const messages = descriptions.flatMap((description, branch) =>
    Array.from({ length: 65 }, (_, index) => ({
      type: 'message',
      id: `b${branch}m${index}`,
      parentId: index ? `b${branch}m${index - 1}` : null,
      message: {
        role: 'user',
        content:
          index === 64
            ? 'I will send it.'
            : index === 3
              ? `Antecedent: ${description}`
              : `earlier context ${index}`,
      },
    })),
  );
  writeFileSync(
    file,
    [{ type: 'session', id: 'session', cwd: dir }, ...messages]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  current = new CaptureReview(
    prepareReview(
      [{ file, sessionId: 'session' }],
      descriptions.map((_, branch) => ({
        file,
        sessionId: 'session',
        entryId: `b${branch}m63`,
        since: null,
      })),
    ),
    () => {},
  );
  scenario(async ({ evidence, lookup }) => {
    const records: CaptureRecord[] = [];
    const dispositions = [];
    for (const [index, entry] of evidence.entries()) {
      const reference = captureReference(entry);
      const detail = await lookup<{
        contextOnly: boolean;
        groups: { branchId: string; entries: { entryId: string; text: string }[] }[];
        nextSkip: number | null;
      }>('remembrancer_context', {
        selected: {
          sessionId: entry.sessionId,
          branchId: entry.branchId,
          entryId: entry.entryId,
          editId: entry.editId,
        },
        skip: 60,
        before: 1,
      });
      expect(detail.contextOnly).toBe(true);
      expect(detail.nextSkip).toBe(61);
      expect(detail.groups[0]!.branchId).toBe(entry.branchId);
      expect(detail.groups[0]!.entries[0]!.entryId).toBe(entry.entryId.replace('m64', 'm3'));
      const description = detail.groups[0]!.entries[0]!.text.slice('Antecedent: '.length);
      records.push(
        captureRecord(
          String(index),
          [{ kind: 'accepted', reference }],
          [
            {
              branchId: entry.branchId,
              state: {
                ...active,
                draft: {
                  change: intent({ ...add, fields: { description } }).change,
                  question: null,
                },
              },
            },
          ],
        ),
      );
      dispositions.push(
        captureDisposition(
          [String(index)],
          intent({ ...add, fields: { description } }),
          'Branch-specific antecedent',
        ),
      );
    }
    return { records, dispositions };
  });
  const submissions = await run();
  expect(
    submissions.map((item) => item.change.operation === 'add' && item.change.fields.description),
  ).toEqual(descriptions);
  expect(
    submissions.map((item) =>
      item.references.map(({ entryId, offset, quote }) => ({ entryId, offset, quote })),
    ),
  ).toEqual(
    descriptions.map((_, branch) => [
      { entryId: `b${branch}m64`, offset: 0, quote: 'I will send it.' },
    ]),
  );
});
