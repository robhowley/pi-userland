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
import { lookupTasks, snapshot } from '../extensions/remembrancer/taskwarrior.js';
import type { Proposal, ProposalDraft } from '../extensions/remembrancer/proposals.js';
import { answerCapture, captureAnswer, stepWork } from './fixtures/capture-steps.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewerStep: vi.fn() }));
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  lookupTasks: vi.fn(),
}));
let dir: string;
let current: CaptureReview;
let db: CheckpointStore;
let rows: Proposal[];
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
  db = {
    proposals: (_state: unknown, offset: number, limit: number) =>
      rows.slice(offset, offset + limit),
    proposal: (id: string) => rows.find((row) => row.id === id),
  } as CheckpointStore;
  runner.mockReset().mockImplementation((input) => answerCapture(input));
  vi.mocked(lookupTasks).mockReset().mockResolvedValue({ tasks: [], nextOffset: null });
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

it('reconstructs oversized saved detail/evidence on host and uses the effective draft before revising', async () => {
  rows = [saved()];
  const seen: { path: string[]; text?: string }[] = [];
  let effectiveDraft: ProposalDraft | undefined;
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    let answer: unknown;
    if (work.catalogue?.[0]?.handle)
      answer = { candidates: work.catalogue.map((item: { handle: string }) => item.handle) };
    else if (work.page) {
      seen.push(work.page);
      answer = { notes: 'Effective edited draft, exact saved evidence read' };
    } else if (input.instruction.includes('All exact candidate fields')) {
      effectiveDraft = rows[0]!.draft!;
      answer = {
        match: 'same',
        state: { summary: 'comparison', status: 'active', draft: effectiveDraft },
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
        page.text === 'Effective edited draft',
    ),
  ).toBe(true);
  expect(seen.some((page) => page.text === 'Old automatic interpretation')).toBe(false);
  expect(
    runner.mock.calls.every(
      ([input]) => Buffer.byteLength(input.instruction) < model.contextWindow - model.maxTokens,
    ),
  ).toBe(true);
});

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
  expect(list.mock.calls.map((args) => args[1])).toEqual([0, 20, 40]);
});

it.each(['detail', 'evidence'])(
  'aborts stale saved %s continuation without materializing or publishing',
  async (phase) => {
    rows = [saved()];
    const original = proposalReads.readProposals;
    vi.spyOn(proposalReads, 'readProposals').mockImplementation((store, args) => {
      if (
        args.action === phase &&
        (phase === 'detail' ? (args.position ?? 0) > 0 : (args.quotePosition ?? 0) > 0)
      )
        rows[0]!.revision++;
      return original(store, args);
    });
    runner.mockImplementation(async (input) => {
      const work = stepWork(input.instruction);
      return answerCapture(
        input,
        work.catalogue?.[0]?.handle
          ? { candidates: work.catalogue.map((item) => item.handle) }
          : captureAnswer(input.instruction),
      );
    });
    await expect(run()).rejects.toThrow('Stale proposal');
    expect(runner.mock.calls.some(([input]) => input.instruction.includes('Materialize'))).toBe(
      false,
    );
    expect(() => current.completion([])).toThrow('reconciliation');
  },
);

it('matches completed tasks from exhaustive pages and host-validates the exact target', async () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const task = { uuid, status: 'pending', description: 'Comparison' };
  vi.mocked(lookupTasks).mockImplementation(async ({ offset } = {}) =>
    offset === 0
      ? {
          tasks: [{ ...task, uuid: '12345678-1234-1234-1234-123456789abd', status: 'completed' }],
          nextOffset: 1,
        }
      : { tasks: [task], nextOffset: null },
  );
  runner.mockImplementation(async (input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    let answer: unknown;
    if (work.catalogue?.[0]?.handle)
      answer = { candidates: work.catalogue.map((item: { handle: string }) => item.handle) };
    else if (work.page) answer = { notes: 'Task exact fields inspected' };
    else if (input.instruction.includes('All exact candidate fields'))
      answer = {
        match: work.handle === 'task:0' ? 'different' : 'same',
        state: {
          summary: 'Comparison',
          status: 'completed',
          draft: {
            change: { operation: 'complete', targetUuid: uuid, annotations: [] },
            expected: snapshot(task),
            question: null,
          },
        },
      };
    else answer = captureAnswer(input.instruction);
    if (input.instruction.includes('Materialize'))
      answer = {
        reason: 'Completed existing task',
        submission: { ...work.state.draft, explanation: 'Explicit completion' },
      };
    return answerCapture(input, answer);
  });
  const submissions = await run();
  expect(submissions[0]!.change).toMatchObject({ operation: 'complete', targetUuid: uuid });
  expect(lookupTasks).toHaveBeenCalledTimes(2);
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

it('services distant frozen context in fresh bounded field passes, not a tool conversation', async () => {
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
    if (work.page) {
      sawDistantContext ||= work.page.text === 'earlier context 3';
      return answerCapture(input, { notes: 'Frozen antecedent is comparison' });
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(sawDistantContext).toBe(true);
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.references.every((ref) => ref.entryId === 'm64')).toBe(true);
});
