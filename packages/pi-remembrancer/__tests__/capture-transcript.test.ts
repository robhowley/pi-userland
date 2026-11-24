import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { runReviewerStep, type ReviewerStepInput } from '../extensions/remembrancer/reviewer.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import { answerCapture } from './fixtures/capture-steps.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewerStep: vi.fn() }));
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn(),
}));
const model = { contextWindow: 32768, maxTokens: 2048 } as NonNullable<ReviewerStepInput['model']>;
const runner = vi.mocked(runReviewerStep);
let dir: string;
let current: CaptureReview;
const msg = (id: string, parentId: string | null, text: string, role = 'user') => ({
  type: 'message',
  id,
  parentId,
  message: { role, content: text },
});
function prepare(records: unknown[], checkpoint?: string) {
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    [{ type: 'session', id: 'session', cwd: dir }, ...records]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  current = new CaptureReview(
    prepareReview(
      [{ file, sessionId: 'session' }],
      checkpoint ? [{ file, sessionId: 'session', entryId: checkpoint, since: null }] : [],
    ),
    () => {},
  );
}
const db = {
  contextGeneration: () => 0,
  proposals: () => [],
  proposal: () => undefined,
} as unknown as CheckpointStore;
const run = () =>
  reviewPreparedCapture(current, db, { cwd: dir, sessionId: 'session', model }, () => {});
const payload = (input: ReviewerStepInput) =>
  JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1));
async function inspect(input: ReviewerStepInput, request: object) {
  const tool = input.tools[0]!;
  await tool.execute(
    'inspect',
    { result: { inspect: request, memory: 'Read exact supporting context' } },
    undefined,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );
  return { status: 'handoff', message: {} } as Awaited<ReturnType<typeof runReviewerStep>>;
}
const extracted = (observations: object[]) => ({ complete: true, observations });
const observation = (kind: string, label: string, start: number, end: number) => ({
  kind,
  label,
  start,
  end,
});
function tuples(submissions: Awaited<ReturnType<typeof run>>) {
  return submissions.flatMap((item) =>
    item.references.map(({ sessionId, branchId, entryId, editId, offset, quote }) => [
      sessionId,
      branchId,
      entryId,
      editId,
      offset,
      quote,
    ]),
  );
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-transcript-'));
  runner.mockReset().mockImplementation((input) => answerCapture(input));
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it('reads distant same-message text and saves an exact citation spanning a primary cut', async () => {
  const quote = `I will send Alice ${'the report '.repeat(20)}Monday.`;
  const text = 'x'.repeat(25) + quote + ' '.repeat(100);
  prepare([msg('intent', null, text)]);
  const next = current.nextExtraction.bind(current);
  vi.spyOn(current, 'nextExtraction').mockImplementation((units) =>
    next(Math.min(units ?? 32, 32)),
  );
  let sawExact = false;
  runner.mockImplementation(async (input) => {
    const { work, detail } = payload(input);
    if (work.range) {
      if (work.range.offset < 25 + quote.length && work.range.end >= 25 + quote.length) {
        expect(work.range.offset - 25).toBeGreaterThan(80);
        if (!detail)
          return inspect(input, { kind: 'context', rangeId: work.range.id, messageOffset: 25 });
        expect(detail.message).toBe(true);
        expect(detail.groups[0].entries[0]).toMatchObject({
          offset: 25,
          text: expect.stringContaining(quote),
        });
        sawExact = true;
        return answerCapture(
          input,
          extracted([observation('accepted', 'Alice report', 25, 25 + quote.length)]),
        );
      }
      return answerCapture(input, extracted([]));
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(sawExact).toBe(true);
  expect(tuples(submissions)).toEqual([['session', 'intent', 'intent', null, 25, quote]]);
  expect(() => current.completion(submissions)).not.toThrow();
  expect(current.nextExtraction()).toBeNull();
});

it.each([false, true])(
  'assigns a shared correction separately on each branch (identical intent text: %s)',
  async (identical) => {
    const a = identical ? 'I will send the report.' : 'I will send Alice the report.';
    const b = identical ? a : 'I will send Bob the report.';
    prepare([
      msg('shared', null, 'Actually Monday.'),
      msg('a', 'shared', a),
      msg('b', 'shared', b),
    ]);
    let sharedExtractions = 0;
    runner.mockImplementation(async (input) => {
      const { work } = payload(input);
      if (work.range) {
        if (work.range.occurrences[0].entryId === 'shared') {
          sharedExtractions++;
          return answerCapture(
            input,
            extracted([observation('correction', 'Monday', work.range.offset, work.range.end)]),
          );
        }
        return answerCapture(
          input,
          extracted([
            observation(
              'accepted',
              work.range.occurrences[0].entryId,
              work.range.offset,
              work.range.end,
            ),
          ]),
        );
      }
      if (work.catalogue)
        return answerCapture(input, {
          candidates: work.catalogue.map((item: { id: string }) => item.id),
        });
      if (work.candidate)
        return answerCapture(input, {
          match:
            work.observation.range.occurrences[0].branchId ===
            work.candidate.first.range.occurrences[0].branchId
              ? 'same'
              : 'different',
        });
      if (work.observation) {
        const branchId = work.branchId;
        expect(work.observation.range.occurrences[0].branchId).toBe(branchId);
        return answerCapture(input, {
          summary: branchId,
          status: 'active',
          draft: {
            change: {
              operation: 'add',
              fields: {
                description: `Send ${branchId === 'a' ? 'Alice' : 'Bob'} the report Monday`,
              },
              annotations: [],
            },
            expected: null,
            question: null,
          },
        });
      }
      return answerCapture(input);
    });
    const submissions = await run();
    expect(sharedExtractions).toBe(1);
    expect(submissions.map((item) => item.change)).toEqual(
      ['Alice', 'Bob'].map((name) => ({
        operation: 'add',
        fields: { description: `Send ${name} the report Monday` },
        annotations: [],
      })),
    );
    expect(tuples(submissions)).toEqual([
      ['session', 'a', 'a', null, 0, a],
      ['session', 'a', 'shared', null, 0, 'Actually Monday.'],
      ['session', 'b', 'b', null, 0, b],
      ['session', 'b', 'shared', null, 0, 'Actually Monday.'],
    ]);
  },
);

it('folds equivalent shared history once while preserving both occurrence references', async () => {
  prepare([
    msg('shared', null, 'I will send the comparison.'),
    msg('a', 'shared', 'Context only', 'assistant'),
    msg('b', 'shared', 'Context only', 'assistant'),
  ]);
  const submissions = await run();
  const folds = runner.mock.calls.filter(([input]) =>
    input.instruction.includes('Fold this exact observation'),
  );
  expect(folds).toHaveLength(1);
  expect(tuples(submissions)).toEqual([
    ['session', 'a', 'shared', null, 0, 'I will send the comparison.'],
    ['session', 'b', 'shared', null, 0, 'I will send the comparison.'],
  ]);
});

it('defaults finding context to the currently folded branch, not alias zero', async () => {
  prepare([
    msg('prior', null, 'Recipient is Alice.'),
    msg('shared', 'prior', 'I will send it.'),
    msg('a', 'shared', 'progress:comparison|Sending now'),
    msg('b', 'shared', 'progress:comparison|Sending now'),
  ]);
  let sharedId = '';
  let sawB = false;
  runner.mockImplementation(async (input) => {
    const { work, detail } = payload(input);
    if (work.observation && !work.candidate && !work.catalogue) {
      if (work.observation.range.occurrences[0].entryId === 'shared')
        sharedId = work.observation.id;
      if (work.branchId === 'b' && work.observation.range.occurrences[0].entryId === 'b') {
        if (!detail) return inspect(input, { kind: 'context', findingId: sharedId });
        expect(detail.selected.branchId).toBe('b');
        expect(detail.groups[0].entries[0].text).toBe('Recipient is Alice.');
        sawB = true;
      }
    }
    return answerCapture(input);
  });
  await run();
  expect(sawB).toBe(true);
});

it('returns exact older windows and cursors, and uses the distant antecedent in the saved proposal', async () => {
  const records = Array.from({ length: 65 }, (_, index) =>
    msg(
      `m${index}`,
      index ? `m${index - 1}` : null,
      index === 64
        ? 'I will send it.'
        : index === 3
          ? 'Recipient is Alice.'
          : `Earlier context ${index}.`,
    ),
  );
  prepare(records, 'm63');
  let found = false;
  let pages = 0;
  let skip = 0;
  runner.mockImplementation(async (input) => {
    const { work, detail } = payload(input);
    expect(input.instruction).not.toContain('Interpret this supporting context field');
    if (work.observation && !work.catalogue && !work.candidate) {
      if (!detail)
        return inspect(input, { kind: 'context', findingId: work.observation.id, before: 40 });
      pages++;
      const exact = detail.groups
        .flatMap((group: { entries: { text: string }[] }) => group.entries)
        .map((entry: { text: string }) => entry.text)
        .join('');
      found ||= exact.includes('Recipient is Alice.');
      if (!found) {
        if (detail.nextOffset !== null)
          return inspect(input, {
            kind: 'context',
            findingId: work.observation.id,
            before: 40,
            skip,
            offset: detail.nextOffset,
          });
        expect(detail.nextSkip).not.toBeNull();
        skip = detail.nextSkip;
        return inspect(input, {
          kind: 'context',
          findingId: work.observation.id,
          before: 40,
          skip,
        });
      }
      return answerCapture(input, {
        summary: 'Send Alice the report',
        status: 'active',
        draft: {
          change: {
            operation: 'add',
            fields: { description: 'Send Alice the report' },
            annotations: [],
          },
          expected: null,
          question: null,
        },
      });
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(found).toBe(true);
  expect(pages).toBeGreaterThan(2);
  expect(submissions[0]!.change).toMatchObject({
    fields: { description: 'Send Alice the report' },
  });
  expect(tuples(submissions)).toEqual([['session', 'm64', 'm64', null, 0, 'I will send it.']]);
});

it('clears provisional identity links after a decisive bridge resolves them', async () => {
  prepare([
    msg('a', null, 'accepted:report|Send the report'),
    msg('b', 'a', 'reference:it|That one'),
    msg('c', 'b', 'correction:resolved|The report, to Alice'),
  ]);
  runner.mockImplementation(async (input) => {
    const { work } = payload(input);
    if (work.catalogue)
      return answerCapture(input, {
        candidates: work.catalogue.map((item: { id: string }) => item.id),
      });
    if (work.candidate)
      return answerCapture(input, {
        match: work.bridge || work.observation.label === 'resolved' ? 'same' : 'ambiguous',
      });
    return answerCapture(input);
  });
  const submissions = await run();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.question).toBeNull();
  expect(tuples(submissions).map((tuple) => tuple[2])).toEqual(['a', 'b', 'c']);
});

it('clears a provisional link when later evidence decisively separates the obligations', async () => {
  prepare([
    msg('a', null, 'accepted:alpha|Send the report'),
    msg('b', 'a', 'accepted:beta|Send the other report'),
    msg('c', 'b', 'correction:resolved|The second report is for Bob, not Alice'),
  ]);
  runner.mockImplementation(async (input) => {
    const { work } = payload(input);
    if (work.catalogue)
      return answerCapture(input, {
        candidates: work.catalogue.map((item: { id: string }) => item.id),
      });
    if (work.candidate)
      return answerCapture(input, {
        match:
          work.observation.label === 'beta'
            ? 'ambiguous'
            : work.candidate.first.label === 'beta'
              ? 'same'
              : 'different',
      });
    return answerCapture(input);
  });
  const submissions = await run();
  expect(submissions).toHaveLength(2);
  expect(submissions.every((item) => item.question === null)).toBe(true);
  expect(tuples(submissions).map((tuple) => tuple[2])).toEqual(['a', 'b', 'c']);
});

it('does not merge contradictory founders merely because a bridge matches both', async () => {
  prepare([
    msg('a', null, 'accepted:Alice|Send Alice the report'),
    msg('b', 'a', 'accepted:Bob|Send Bob the report'),
    msg('c', 'b', 'correction:bridge|Send it Monday'),
  ]);
  const merge = vi.spyOn(current, 'mergeRecords');
  runner.mockImplementation(async (input) => {
    const { work } = payload(input);
    if (work.catalogue && work.observation.label === 'bridge')
      return answerCapture(input, {
        candidates: work.catalogue.map((item: { id: string }) => item.id),
      });
    if (work.candidate && !work.bridge)
      return answerCapture(input, {
        match: work.observation.label === 'bridge' ? 'same' : 'different',
      });
    if (work.bridge) return answerCapture(input, { match: 'different' });
    return answerCapture(input);
  });
  const submissions = await run();
  expect(merge).not.toHaveBeenCalled();
  expect(submissions).toHaveLength(3);
  expect(submissions.every((item) => !!item.question)).toBe(true);
});

it('rejects coerced finding match enums at ingress', async () => {
  prepare([
    msg('a', null, 'accepted:report|Send the report'),
    msg('b', 'a', 'correction:report|Monday'),
  ]);
  runner.mockImplementation(async (input) =>
    payload(input).work.candidate
      ? answerCapture(input, { match: ['same'] })
      : answerCapture(input),
  );
  await expect(run()).rejects.toThrow('Invalid capture match');
});

it('rejects out-of-order continuation without acknowledging the range', async () => {
  prepare([msg('a', null, 'x'.repeat(80))]);
  runner.mockImplementation(async (input) => {
    const { work } = payload(input);
    return answerCapture(
      input,
      work.observationOffset === 0
        ? {
            complete: false,
            observations: [observation('accepted', 'later', 20, 25)],
            nextObservationOffset: 1,
            memory: 'Earlier span next',
          }
        : extracted([observation('accepted', 'earlier', 5, 10)]),
    );
  });
  await expect(run()).rejects.toThrow('not in source order');
  expect(current.nextExtraction()!.offset).toBe(0);
});

it('allows distinct ordered observations on one span with stable continuation identities', async () => {
  const quote = 'I will send Alice and Bob the report.';
  prepare([msg('root', null, quote), msg('a', 'root', 'Context A'), msg('b', 'root', 'Context B')]);
  runner.mockImplementation(async (input) => {
    const { work } = payload(input);
    if (work.range && work.range.occurrences[0].entryId !== 'root')
      return answerCapture(input, extracted([]));
    if (work.range) {
      expect(work.observationOffset).toBeLessThanOrEqual(1);
      return answerCapture(
        input,
        work.observationOffset === 0
          ? {
              complete: false,
              observations: [
                { ...observation('accepted', 'Alice', 0, quote.length), observationId: 'alice' },
              ],
              nextObservationOffset: 1,
              memory: 'Bob next',
            }
          : extracted([
              { ...observation('accepted', 'Bob', 0, quote.length), observationId: 'bob' },
            ]),
      );
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(submissions).toHaveLength(2);
  expect(tuples(submissions)).toEqual(
    ['a', 'b', 'a', 'b'].map((branchId) => ['session', branchId, 'root', null, 0, quote]),
  );
});

it('delivers the exact founding span to matching, not a retained range handle', async () => {
  const quote = 'I will ' + 'send the report '.repeat(180);
  prepare([msg('a', null, quote), msg('b', 'a', 'correction:report|Monday')]);
  let sawFounder = false;
  runner.mockImplementation(async (input) => {
    const { work } = payload(input);
    if (work.range && work.range.occurrences[0].entryId === 'a')
      return answerCapture(
        input,
        extracted(
          work.range.end === quote.length
            ? [observation('accepted', 'report', 0, quote.length)]
            : [],
        ),
      );
    if (work.candidate) {
      expect(work.candidate.first.range.text).toBe(quote);
      expect(work.candidate.first).toMatchObject({ start: 0, end: quote.length });
      sawFounder = true;
      return answerCapture(input, { match: 'same' });
    }
    return answerCapture(input);
  });
  const submissions = await run();
  expect(sawFounder).toBe(true);
  expect(tuples(submissions)[0]).toEqual(['session', 'b', 'a', null, 0, quote]);
});
