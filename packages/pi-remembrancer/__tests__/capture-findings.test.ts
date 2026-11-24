import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import { runReviewerStep, type ReviewerStepInput } from '../extensions/remembrancer/reviewer.js';
import * as proposalReads from '../extensions/remembrancer/proposal-read.js';
import { CaptureRetryableError } from '../extensions/remembrancer/capture-jobs.js';
import { readTaskCatalog, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import type { Proposal, ProposalDraft } from '../extensions/remembrancer/proposals.js';
import { answerCapture, captureAnswer, stepWork } from './fixtures/capture-steps.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewerStep: vi.fn() }));
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));
let dir: string;
let current: CaptureReview;
let db: CheckpointStore;
let rows: Proposal[];
let generation: number;
const runner = vi.mocked(runReviewerStep);
const model = { contextWindow: 32768, maxTokens: 2048 } as NonNullable<ReviewerStepInput['model']>;
const run = () =>
  reviewPreparedCapture(current, db, { cwd: dir, sessionId: 'session', model }, () => {});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-findings-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'intent',
        parentId: null,
        message: { role: 'user', content: 'I will send the comparison.' },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  current = new CaptureReview(prepareReview([{ file, sessionId: 'session' }], []), () => {});
  rows = [];
  generation = 0;
  db = {
    contextGeneration: () => generation,
    proposals: (_state: unknown, offset: number, limit: number) =>
      rows.slice(offset, offset + limit),
    proposal: (id: string) => rows.find((row) => row.id === id),
  } as CheckpointStore;
  runner.mockReset().mockImplementation((input) => answerCapture(input));
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function saved(): Proposal {
  return {
    id: 'saved',
    revision: 3,
    state: 'pending',
    change: {
      operation: 'add',
      fields: { description: 'Old automatic interpretation' },
      annotations: [],
    },
    expected: null,
    question: null,
    draft: {
      change: {
        operation: 'add',
        fields: { description: 'Effective edited draft' },
        annotations: [],
      },
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

it('does not force an unrelated task match for retained metadata or annotations', async () => {
  vi.mocked(readTaskCatalog).mockResolvedValue([
    {
      uuid: '12345678-1234-1234-1234-123456789abc',
      status: 'pending',
      description: 'Unrelated maintenance',
      custom: 'metadata '.repeat(20000),
      annotations: [{ entry: '20260101T000000Z', description: 'Supporting detail '.repeat(2000) }],
    },
  ]);
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    if (work.catalogue?.[0]?.handle) {
      expect(work.catalogue[0].identity.description).toBe('Unrelated maintenance');
      expect(work.catalogue[0].identity.detail.custom).toEqual({ valueHandle: expect.any(String) });
      expect(work.catalogue[0].identity.annotations[0].description).toEqual({
        valueHandle: expect.any(String),
      });
      expect(work.catalogue[0].uncertainIdentity).toBe(false);
      return answerCapture(input, { candidates: [] });
    }
    return answerCapture(input);
  });
  expect(await run()).toHaveLength(1);
  expect(
    runner.mock.calls.some(([input]) => input.instruction.includes('All exact candidate fields')),
  ).toBe(false);
});

it('exposes a verified UUID and old source clues to match an applied add after a task rename', async () => {
  const task = {
    uuid: '12345678-1234-1234-1234-123456789abc',
    status: 'pending',
    description: 'Renamed deliverable',
  };
  const old = saved();
  rows = [
    {
      ...old,
      draft: null,
      state: 'applied',
      claim: task.uuid,
      result: { state: 'applied', verified: snapshot(task), error: null },
      sources: [
        { ...old.sources[0]!, quote: 'I will send the comparison. ' + 'support '.repeat(1500) },
      ],
    },
  ];
  vi.mocked(readTaskCatalog).mockResolvedValue([task]);
  const exact = new Set<string>();
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    if (work.catalogue?.[0]?.handle) {
      for (const item of work.catalogue) {
        if (item.handle === 'proposal:saved') {
          expect(item.identity.verifiedUuid).toBe(task.uuid);
          expect(item.identity.effectiveClue.description.text).toBe('Old automatic interpretation');
          expect(item.identity.sourceClues[0].quote).toMatchObject({
            text: expect.stringContaining('I will send the comparison.'),
            truncated: true,
          });
          expect(item.identity.sources[0].quote).toEqual({ valueHandle: expect.any(String) });
        }
      }
      return answerCapture(input, {
        candidates: work.catalogue.map((item: { handle: string }) => item.handle),
      });
    }
    if (input.instruction.includes('All exact candidate fields')) {
      exact.add(work.handle);
      expect(work.candidate.verifiedUuid ?? work.candidate.uuid).toBe(task.uuid);
      return answerCapture(input, { match: 'same' });
    }
    if (input.instruction.includes('Materialize')) {
      return answerCapture(input, {
        reason: 'Matched the verified renamed task',
        submission: {
          explanation: 'Matched the verified renamed task',
          change: {
            operation: 'update',
            targetUuid: work.targetUuid,
            fields: { priority: 'H' },
            annotations: [],
          },
          question: null,
        },
      });
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(exact).toEqual(new Set(['task:0', 'proposal:saved']));
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    change: { operation: 'update', targetUuid: task.uuid },
    expected: snapshot(task),
  });
  expect(submissions[0]).not.toHaveProperty('id');
});

it('rechecks catalogue generation even when discovery selects no proposal', async () => {
  rows = [saved()];
  runner.mockImplementation(async (input) => {
    const work = stepWork(input.instruction);
    if (work.catalogue?.[0]?.handle) {
      generation++;
      return answerCapture(input, { candidates: [] });
    }
    return answerCapture(input);
  });
  await expect(run()).rejects.toBeInstanceOf(CaptureRetryableError);
  expect(() => current.completion([])).toThrow('reconciliation');
});

it.each(['plausible', 'uncertain'])(
  'reads exact renamed effective drafts and evidence for %s identity',
  async (identity) => {
    rows = [saved()];
    rows[0]!.draft!.change = {
      operation: 'add',
      fields: {
        description: 'Send the comparison' + (identity === 'uncertain' ? ' '.repeat(3000) : ''),
      },
      annotations: [],
    };
    const seen: { path: string[]; text?: string }[] = [];
    let effectiveDraft: ProposalDraft | undefined;
    runner.mockImplementation(async (input) => {
      const work = JSON.parse(
        input.instruction.slice(input.instruction.lastIndexOf('\n') + 1),
      ).work;
      let answer: unknown;
      if (work.catalogue?.[0]?.handle) {
        expect(work.catalogue[0].identity.effective.change.fields.description).toEqual(
          identity === 'uncertain' ? { valueHandle: expect.any(String) } : 'Send the comparison',
        );
        answer = { candidates: identity === 'plausible' ? [work.catalogue[0].handle] : [] };
      } else if (work.page) {
        seen.push(work.page);
        answer = {
          notes:
            work.page.text?.includes('comparison') || work.notes?.includes('same comparison')
              ? 'same comparison'
              : 'identity unresolved',
        };
      } else if (input.instruction.includes('All exact candidate fields')) {
        effectiveDraft = work.candidate.effective;
        answer = {
          match: work.notes === 'same comparison' ? 'same' : 'different',
        };
      } else if (input.instruction.includes('Materialize')) {
        answer = {
          reason: 'Preserve edited matched draft',
          submission: { ...effectiveDraft, explanation: 'Exact saved draft' },
        };
      } else answer = captureAnswer(input.instruction);
      return answerCapture(input, answer);
    });
    const submissions = await run();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      id: 'saved',
      expectedRevision: 3,
      change: rows[0]!.draft!.change,
      question: 'Keep my draft?',
    });
    expect(
      seen
        .filter((page) => page.path.join('.') === 'explanation')
        .map((page) => page.text)
        .join(''),
    ).toBe(rows[0]!.explanation);
    expect(
      seen
        .filter((page) => page.path.join('.') === 'sources.0.quote')
        .map((page) => page.text)
        .join(''),
    ).toBe(rows[0]!.sources[0]!.quote);
    expect(
      seen.some(
        (page) =>
          page.path.join('.') === 'effective.change.fields.description' &&
          page.text?.startsWith('Send the comparison'),
      ),
    ).toBe(true);
    expect(seen.some((page) => page.text === 'Old automatic interpretation')).toBe(false);
    expect(
      runner.mock.calls.every(
        ([input]) => Buffer.byteLength(input.instruction) < model.contextWindow - model.maxTokens,
      ),
    ).toBe(true);
  },
);

it('examines every saved-proposal discovery page before declaring no existing match', async () => {
  rows = Array.from({ length: 45 }, (_, index) => ({
    ...saved(),
    id: `saved-${index}`,
    explanation: 'short',
    sources: [],
    draft: null,
  }));
  const list = vi.spyOn(db, 'proposals');
  const examined = new Set<string>();
  runner.mockImplementation(async (input) => {
    const work = stepWork(input.instruction);
    if (work.catalogue?.[0]?.handle) {
      work.catalogue.forEach((item) => examined.add(item.handle!));
      return answerCapture(input, { candidates: [] });
    }
    return answerCapture(input);
  });
  expect(await run()).toHaveLength(1);
  expect(examined.size).toBe(45);
  expect(list.mock.calls).toEqual([[undefined, 0, 100]]);
});

it.each(['missing', 'stale', 'other proposal'])(
  'aborts a %s typed candidate change without materializing or publishing',
  async (change) => {
    rows = [saved()];
    const original = rows[0]!;
    runner.mockImplementation(async (input) => {
      const work = stepWork(input.instruction);
      if (work.catalogue?.[0]?.handle) {
        generation++;
        if (change === 'missing') rows = [];
        else if (change === 'stale') rows = [{ ...original, revision: original.revision + 1 }];
        return answerCapture(input, { candidates: work.catalogue.map((item) => item.handle) });
      }
      return answerCapture(input);
    });
    await expect(run()).rejects.toThrow(
      change === 'missing'
        ? 'Missing proposal'
        : change === 'stale'
          ? 'Stale proposal'
          : 'context changed',
    );
    expect(runner.mock.calls.some(([input]) => input.instruction.includes('Materialize'))).toBe(
      false,
    );
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);

it('aborts changes during typed store enumeration rather than accepting a drifting page', async () => {
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
  await expect(run()).rejects.toBeInstanceOf(CaptureRetryableError);
  expect(runner.mock.calls.some(([input]) => input.instruction.includes('Materialize'))).toBe(
    false,
  );
});

it('keeps typed sources and avoids the public JSON and quote-fragment protocol', async () => {
  rows = [saved()];
  const wire = vi.spyOn(proposalReads, 'readProposals');
  const detail = vi.spyOn(db, 'proposal');
  const completion = vi.spyOn(current, 'completion');
  const staged = await run();
  expect(completion).not.toHaveBeenCalled();
  expect(() => current.completion(staged)).not.toThrow();
  expect(completion).toHaveBeenCalledTimes(1);
  expect(wire).not.toHaveBeenCalled();
  expect(detail).not.toHaveBeenCalled();
});

it('matches tasks from one complete typed view and host-validates the exact target', async () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const task = { uuid, status: 'pending', description: 'Comparison' };
  const file = join(dir, 'completed.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'done',
        parentId: null,
        message: { role: 'user', content: 'completion:comparison|I sent the comparison.' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  current = new CaptureReview(prepareReview([{ file, sessionId: 'session' }], []), () => {});
  vi.mocked(readTaskCatalog).mockResolvedValue([
    { ...task, uuid: '12345678-1234-1234-1234-123456789abd', status: 'completed' },
    task,
  ]);
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    let answer: unknown;
    if (work.catalogue?.[0]?.handle)
      answer = { candidates: work.catalogue.map((item: { handle: string }) => item.handle) };
    else if (work.page) answer = { notes: 'Task exact fields inspected' };
    else if (input.instruction.includes('All exact candidate fields'))
      answer = { match: work.handle === 'task:0' ? 'different' : 'same' };
    else answer = captureAnswer(input.instruction);
    if (input.instruction.includes('Materialize'))
      answer = {
        reason: 'Completed existing task',
        submission: {
          change: { operation: 'complete', targetUuid: work.targetUuid, annotations: [] },
          question: null,
          explanation: 'Explicit completion',
        },
      };
    return answerCapture(input, answer);
  });
  const submissions = await run();
  expect(submissions[0]!.change).toMatchObject({ operation: 'complete', targetUuid: uuid });
  expect(readTaskCatalog).toHaveBeenCalledTimes(1);
});

it.each([
  'missing extraction result',
  'invalid range',
  'invalid kind',
  'unmatched target',
  'insufficient context',
])('rejects %s without a completed disposition', async (failure) => {
  runner.mockImplementation(async (input) => {
    const work = stepWork(input.instruction);
    if (failure === 'missing extraction result')
      return { status: 'complete', message: {} } as Awaited<ReturnType<typeof runReviewerStep>>;
    if (work.range && failure === 'invalid range')
      return answerCapture(input, {
        complete: true,
        observations: [{ kind: 'accepted', label: 'comparison', start: 0, end: 99999 }],
      });
    if (work.range && failure === 'invalid kind')
      return answerCapture(input, {
        complete: true,
        observations: [{ kind: 'invented', label: 'comparison', start: 0, end: 1 }],
      });
    if (input.instruction.includes('Materialize') && failure === 'unmatched target') {
      const target = {
        uuid: '12345678-1234-1234-1234-123456789abc',
        status: 'pending',
        description: 'Invented',
      };
      return answerCapture(input, {
        reason: 'Fixture bad target',
        submission: {
          change: { operation: 'complete', targetUuid: target.uuid, annotations: [] },
          expected: snapshot(target),
          question: null,
          explanation: 'Fixture',
        },
      });
    }
    return answerCapture(input);
  });
  const inputModel = failure === 'insufficient context' ? { ...model, contextWindow: 3000 } : model;
  await expect(
    reviewPreparedCapture(
      current,
      db,
      { cwd: dir, sessionId: 'session', model: inputModel },
      () => {},
    ),
  ).rejects.toThrow();
  expect(() => current.completion([])).toThrow();
});

it.each(['correction', 'completion', 'ambiguous'])(
  'accounts for two earlier records after a later %s bridge',
  async (outcome) => {
    const file = join(dir, 'bridge.jsonl');
    const messages = [
      'accepted:alpha|Send the comparison Friday',
      'accepted:beta|Send Maya the report Friday',
      'accepted:bridge|Those are the same delivery',
      `correction:bridge|Send Maya the comparison Monday`,
      ...(outcome === 'completion' ? ['completion:bridge|Sent it'] : []),
    ];
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
    const merged = vi.spyOn(current, 'mergeRecords');
    const disposed = vi.spyOn(current, 'disposeRecord');
    const folded: string[] = [];
    let inspectedMergedHistory = false;
    runner.mockImplementation(async (input) => {
      const { work, detail } = JSON.parse(
        input.instruction.slice(input.instruction.lastIndexOf('\n') + 1),
      );
      if (outcome !== 'ambiguous' && work.candidate?.historyCount === 5 && !detail) {
        const tool = input.tools[0]!;
        await tool.execute(
          'merged-history',
          {
            result: {
              inspect: { kind: 'history', recordId: work.candidate.id, index: 2 },
              memory: 'Read the absorbed record evidence',
            },
          },
          undefined,
          undefined,
          {} as Parameters<typeof tool.execute>[4],
        );
        return { status: 'handoff', message: {} } as Awaited<ReturnType<typeof runReviewerStep>>;
      }
      if (detail) {
        expect(detail.finding.label).toBe('beta');
        expect(detail.finding.range.occurrenceCount).toBe(1);
        expect(detail.finding.sourceOccurrenceCount).toBe(2);
        inspectedMergedHistory = true;
      }
      let answer = captureAnswer(input.instruction);
      if (work.catalogue && work.observation?.label === 'bridge')
        answer = { candidates: work.catalogue.map((item: { id: string }) => item.id) };
      if (work.candidate && (work.observation?.label === 'bridge' || work.bridge))
        answer = { match: outcome === 'ambiguous' ? 'ambiguous' : 'same' };
      if (work.observation && !work.catalogue && !work.candidate)
        folded.push(work.observation.range.occurrences[0]!.entryId);
      return answerCapture(input, answer);
    });
    const submissions = await run();
    expect(() => current.completion(submissions)).not.toThrow();
    if (outcome === 'ambiguous') {
      expect(merged).not.toHaveBeenCalled();
      expect(submissions.every((submission) => Boolean(submission.question))).toBe(true);
      expect(disposed).toHaveBeenCalledTimes(6);
    } else {
      expect(merged).toHaveBeenCalledExactlyOnceWith('r1', ['r2']);
      expect(inspectedMergedHistory).toBe(true);
      expect(disposed).toHaveBeenCalledTimes(1);
      const history = messages.map((_item, index) => `m${index}`);
      expect(folded).toEqual(history); // Identical ordered history and frozen context reuse the fold.
      if (outcome === 'completion') {
        expect(submissions).toEqual([]);
        expect(disposed).toHaveBeenCalledWith('r1', null);
      } else {
        expect(submissions).toHaveLength(1);
        expect(submissions[0]!.question).toBeNull();
        expect(submissions[0]!.change).toMatchObject({
          fields: { description: 'Send Maya the comparison Monday' },
        });
        expect(submissions[0]!.references.map((reference) => reference.entryId)).toEqual([
          'm0',
          'm0',
          'm1',
          'm1',
          'm2',
          'm2',
          'm3',
          'm3',
        ]);
        expect(
          new Set(submissions[0]!.references.map((reference) => reference.branchId)).size,
        ).toBe(2);
      }
    }
  },
);

it('reads extra exact history only by a bounded validated handle, not all pairs', async () => {
  const file = join(dir, 'history.jsonl');
  writeFileSync(
    file,
    [
      { type: 'session', id: 'session', cwd: dir },
      {
        type: 'message',
        id: 'a',
        parentId: null,
        message: { role: 'user', content: 'accepted:alpha|Friday' },
      },
      {
        type: 'message',
        id: 'b',
        parentId: 'a',
        message: { role: 'user', content: 'correction:alpha|Monday' },
      },
      {
        type: 'message',
        id: 'c',
        parentId: 'b',
        message: { role: 'user', content: 'progress:alpha|Waiting on Maya' },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  current = new CaptureReview(prepareReview([{ file, sessionId: 'session' }], []), () => {});
  let requested = false;
  let read = false;
  runner.mockImplementation(async (input) => {
    const { work, detail } = JSON.parse(
      input.instruction.slice(input.instruction.lastIndexOf('\n') + 1),
    );
    if (work.candidate?.historyCount === 2 && !requested) {
      requested = true;
      const tool = input.tools[0]!;
      await tool.execute(
        'history',
        {
          result: {
            inspect: { kind: 'history', recordId: work.candidate.id, index: 1 },
            memory: 'Read the correction exactly',
          },
        },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      );
      return { status: 'handoff', message: {} } as Awaited<ReturnType<typeof runReviewerStep>>;
    }
    if (detail) {
      expect(detail.finding.range.text).toBe('correction:alpha|Monday');
      expect(detail.nextIndex).toBeNull();
      read = true;
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(read).toBe(true);
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.references).toHaveLength(3);
});

it.each([
  'skipped cursor',
  'empty continuation',
  'replayed observation',
  'invented value',
  'invalid alias',
  'failure after page',
])('does not acknowledge a dense range after %s', async (failure) => {
  let calls = 0;
  runner.mockImplementation(async (input) => {
    calls++;
    const work = stepWork(input.instruction);
    if (failure === 'invented value' || failure === 'invalid alias') {
      const tool = input.tools[0]!;
      await tool.execute(
        'inspect',
        {
          result: {
            inspect:
              failure === 'invented value'
                ? { kind: 'value', valueHandle: 'invented', index: 0 }
                : {
                    kind: 'occurrences',
                    rangeId: (work.range as unknown as { id: string }).id,
                    index: 100,
                  },
            memory: 'Read exact detail',
          },
        },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      );
      return { status: 'handoff', message: {} } as Awaited<ReturnType<typeof runReviewerStep>>;
    }
    if (calls === 2 && failure === 'failure after page')
      throw new Error('Provider failure after page');
    const range = work.range!;
    return answerCapture(input, {
      complete: calls > 1,
      observations:
        failure === 'empty continuation'
          ? []
          : [{ kind: 'accepted', label: 'comparison', start: range.offset, end: range.end }],
      nextObservationOffset:
        calls > 1
          ? null
          : failure === 'skipped cursor'
            ? 2
            : failure === 'empty continuation'
              ? 0
              : 1,
      memory: 'Continue the observations',
    });
  });
  await expect(run()).rejects.toThrow();
  expect(current.nextExtraction()!.offset).toBe(0);
  expect(() => current.completion([])).toThrow('every original evidence range');
  expect(runner.mock.calls.some(([input]) => input.instruction.includes('Materialize'))).toBe(
    false,
  );
});

it('services distant frozen context as exact pages with real cursors, not a tool conversation', async () => {
  const file = join(dir, 'context.jsonl');
  const messages = Array.from({ length: 65 }, (_, index) => ({
    type: 'message',
    id: `m${index}`,
    parentId: index ? `m${index - 1}` : null,
    message: {
      role: 'user',
      content: index === 64 ? 'I will send the comparison.' : `earlier context ${index}`,
    },
  }));
  writeFileSync(
    file,
    [{ type: 'session', id: 'session', cwd: dir }, ...messages]
      .map((item) => JSON.stringify(item))
      .join('\n') + '\n',
  );
  current = new CaptureReview(
    prepareReview(
      [{ file, sessionId: 'session' }],
      [{ file, sessionId: 'session', entryId: 'm63', since: null }],
    ),
    () => {},
  );
  let requested = false;
  let sawDistantContext = false;
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    if (work.observation && !requested) {
      requested = true;
      const tool = input.tools[0]!;
      await tool.execute(
        'context',
        {
          result: {
            inspect: { kind: 'context', findingId: work.observation.id, skip: 60 },
            memory: 'Resolve the antecedent',
          },
        },
        undefined,
        undefined,
        {} as Parameters<typeof tool.execute>[4],
      );
      return { status: 'handoff', message: {} } as Awaited<ReturnType<typeof runReviewerStep>>;
    }
    const { detail } = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1));
    if (detail) {
      expect(detail.contextOnly).toBe(true);
      expect(detail.nextOffset).toBeNull();
      expect(detail.nextSkip).toBe(61);
      sawDistantContext = detail.groups[0].entries[0].text === 'earlier context 3';
      expect(sawDistantContext).toBe(true);
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(sawDistantContext).toBe(true);
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.references.every((ref) => ref.entryId === 'm64')).toBe(true);
});
