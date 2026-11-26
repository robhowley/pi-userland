import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { reviewPreparedCapture } from '../extensions/remembrancer/capture.js';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { runReviewer, type ReviewerInput } from '../extensions/remembrancer/reviewer.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import {
  answerCaptureReview,
  captureDisposition,
  captureRecord,
  captureReference,
  reviewerPaths,
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
const model = { contextWindow: 32768, maxTokens: 2048 } as NonNullable<ReviewerInput['model']>;
const runner = vi.mocked(runReviewer);
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
const intent = (description: string, question: string | null = null) => ({
  change: { operation: 'add' as const, fields: { description }, annotations: [] },
  question,
  explanation: 'Reviewer interpretation',
});
const state = (branchId: string, description: string) => ({
  branchId,
  state: {
    summary: description,
    status: 'active',
    draft: { change: intent(description).change, question: null },
  },
});
function scenario(answer: CaptureScenario) {
  runner.mockImplementation((input) => answerCaptureReview(input, answer));
}
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
  runner.mockReset();
  vi.mocked(readTaskCatalog).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

it('reassembles distant same-message text and saves an exact citation spanning an evidence cut', async () => {
  const quote = `I will send Alice ${'the report 😀 '.repeat(6000)}Monday.`;
  const text = 'x'.repeat(25) + quote + ' '.repeat(100);
  prepare([msg('intent', null, text)]);
  scenario(({ evidence }) => {
    expect(evidence.length).toBeGreaterThan(1);
    expect(evidence.map((entry) => entry.text).join('')).toBe(text);
    expect(evidence[1]!.offset).toBeGreaterThan(25);
    const reference = { ...captureReference(evidence[0]!), offset: 25, quote };
    return {
      records: [
        captureRecord(
          'report',
          [{ kind: 'accepted', reference }],
          [state('intent', 'Send Alice the report Monday')],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['report'],
          intent('Send Alice the report Monday'),
          'One commitment across fragments',
        ),
      ],
    };
  });
  const submissions = await run();
  expect(tuples(submissions)).toEqual([['session', 'intent', 'intent', null, 25, quote]]);
  expect(() => current.completion(submissions)).not.toThrow();
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
    scenario(({ evidence }) => {
      expect(evidence.map((entry) => [entry.branchId, entry.entryId])).toEqual([
        ['a', 'shared'],
        ['a', 'a'],
        ['b', 'shared'],
        ['b', 'b'],
      ]);
      return {
        records: ['a', 'b'].map((branchId) =>
          captureRecord(
            branchId,
            [
              {
                kind: 'accepted',
                reference: captureReference(evidence.find((entry) => entry.entryId === branchId)!),
              },
              {
                kind: 'correction',
                reference: captureReference(
                  evidence.find(
                    (entry) => entry.branchId === branchId && entry.entryId === 'shared',
                  )!,
                ),
              },
            ],
            [state(branchId, `Send ${branchId === 'a' ? 'Alice' : 'Bob'} the report Monday`)],
          ),
        ),
        dispositions: ['a', 'b'].map((branchId) =>
          captureDisposition(
            [branchId],
            intent(`Send ${branchId === 'a' ? 'Alice' : 'Bob'} the report Monday`),
            'Branch-specific interpretation',
          ),
        ),
      };
    });
    const submissions = await run();
    expect(submissions.map((item) => item.change)).toEqual(
      ['Alice', 'Bob'].map((name) => intent(`Send ${name} the report Monday`).change),
    );
    expect(tuples(submissions)).toEqual([
      ['session', 'a', 'a', null, 0, a],
      ['session', 'a', 'shared', null, 0, 'Actually Monday.'],
      ['session', 'b', 'b', null, 0, b],
      ['session', 'b', 'shared', null, 0, 'Actually Monday.'],
    ]);
  },
);
it('lets the reviewer consolidate equivalent shared history while preserving both branch references', async () => {
  prepare([
    msg('shared', null, 'I will send the comparison.'),
    msg('a', 'shared', 'Context only', 'assistant'),
    msg('b', 'shared', 'Context only', 'assistant'),
  ]);
  scenario(({ evidence }) => {
    const shared = evidence.filter((entry) => entry.entryId === 'shared');
    return {
      records: [
        captureRecord(
          'comparison',
          shared.map((entry) => ({ kind: 'accepted', reference: captureReference(entry) })),
          ['a', 'b'].map((branchId) => state(branchId, 'Comparison')),
        ),
      ],
      dispositions: [
        captureDisposition(['comparison'], intent('Comparison'), 'Shared accepted intent'),
      ],
    };
  });
  expect(tuples(await run())).toEqual([
    ['session', 'a', 'shared', null, 0, 'I will send the comparison.'],
    ['session', 'b', 'shared', null, 0, 'I will send the comparison.'],
  ]);
});
it('selects supporting context in the explicitly requested branch, not alias zero', async () => {
  prepare([
    msg('prior', null, 'Recipient is Alice.'),
    msg('shared', 'prior', 'I will send it.'),
    msg('a', 'shared', 'progress:comparison|Sending now'),
    msg('b', 'shared', 'progress:comparison|Sending now'),
  ]);
  scenario(async ({ evidence, lookup }) => {
    const selected = captureReference(
      evidence.find((entry) => entry.branchId === 'b' && entry.entryId === 'shared')!,
    );
    const detail = await lookup<{
      selected: { branchId: string };
      groups: { branchId: string; entries: { text: string }[] }[];
    }>('remembrancer_context', {
      selected: {
        sessionId: selected.sessionId,
        branchId: selected.branchId,
        entryId: selected.entryId,
        editId: selected.editId,
      },
    });
    expect(detail.selected.branchId).toBe('b');
    expect(detail.groups[0]!.branchId).toBe('b');
    expect(detail.groups[0]!.entries[0]!.text).toBe('Recipient is Alice.');
    return {
      records: [
        captureRecord(
          'alice',
          [{ kind: 'accepted', reference: selected }],
          [state('b', 'Send Alice the report')],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['alice'],
          intent('Send Alice the report'),
          'Pronoun resolved in branch b',
        ),
      ],
    };
  });
  expect((await run())[0]!.references[0]!.branchId).toBe('b');
});
it('returns exact older windows and cursors, using the distant antecedent without citing context', async () => {
  prepare(
    Array.from({ length: 65 }, (_, index) =>
      msg(
        `m${index}`,
        index ? `m${index - 1}` : null,
        index === 64
          ? 'I will send it.'
          : index === 3
            ? 'Recipient is Alice.'
            : `Earlier context ${index}.`,
      ),
    ),
    'm63',
  );
  let pages = 0;
  scenario(async ({ evidence, lookup }) => {
    expect(evidence).toHaveLength(1);
    const reference = captureReference(evidence[0]!);
    const selected = {
      sessionId: reference.sessionId,
      branchId: reference.branchId,
      entryId: reference.entryId,
      editId: reference.editId,
    };
    let skip = 0;
    let offset = 0;
    let found = false;
    do {
      const page = await lookup<{
        contextOnly: boolean;
        groups: { entries: { text: string }[] }[];
        nextOffset: number | null;
        nextSkip: number | null;
      }>('remembrancer_context', { selected, before: 40, skip, offset });
      pages++;
      expect(page.contextOnly).toBe(true);
      found = page.groups.some((group) =>
        group.entries.some((entry) => entry.text === 'Recipient is Alice.'),
      );
      if (found) break;
      if (page.nextOffset !== null) offset = page.nextOffset;
      else if (page.nextSkip !== null) {
        skip = page.nextSkip;
        offset = 0;
      } else throw new Error('Antecedent not delivered');
    } while (!found);
    return {
      records: [
        captureRecord(
          'report',
          [{ kind: 'accepted', reference }],
          [state('m64', 'Send Alice the report')],
        ),
      ],
      dispositions: [
        captureDisposition(['report'], intent('Send Alice the report'), 'Distant antecedent'),
      ],
    };
  });
  const submissions = await run();
  expect(pages).toBeGreaterThan(1);
  expect(submissions[0]!.change).toEqual(intent('Send Alice the report').change);
  expect(tuples(submissions)).toEqual([['session', 'm64', 'm64', null, 0, 'I will send it.']]);
});
it('rejects supporting-only historical text as submitted commitment evidence', async () => {
  prepare(
    [msg('prior', null, 'I will send Alice the report.'), msg('later', 'prior', 'I will send it.')],
    'prior',
  );
  scenario(async ({ evidence, lookup }) => {
    const entry = evidence[0]!;
    const context = await lookup<{
      groups: {
        entries: { entryId: string; editId: string | null; offset: number; text: string }[];
      }[];
    }>('remembrancer_context', {
      selected: {
        sessionId: entry.sessionId,
        branchId: entry.branchId,
        entryId: entry.entryId,
        editId: entry.editId,
      },
    });
    const prior = context.groups[0]!.entries[0]!;
    expect(prior.entryId).toBe('prior');
    const reference = {
      ...captureReference(entry),
      entryId: prior.entryId,
      editId: prior.editId,
      offset: prior.offset,
      quote: prior.text,
    };
    return {
      records: [
        captureRecord(
          'report',
          [{ kind: 'accepted', reference }],
          [state(entry.branchId, 'Send Alice the report')],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['report'],
          intent('Send Alice the report'),
          'Forbidden historical evidence',
        ),
      ],
    };
  });
  await expect(run()).rejects.toThrow('Reference does not match frozen eligible evidence');
});
it('accepts the reviewer-resolved bridge as one unambiguous record', async () => {
  prepare([
    msg('a', null, 'accepted:report|Send the report'),
    msg('b', 'a', 'reference:it|That one'),
    msg('c', 'b', 'correction:resolved|The report, to Alice'),
  ]);
  scenario(({ evidence }) => ({
    records: [
      captureRecord(
        'report',
        evidence.map((entry, index) => ({
          kind: ['accepted', 'reference', 'correction'][index]!,
          reference: captureReference(entry),
        })),
        [state('c', 'Send Alice the report')],
      ),
    ],
    dispositions: [
      captureDisposition(
        ['report'],
        intent('Send Alice the report'),
        'The last correction resolves the reference',
      ),
    ],
  }));
  const submissions = await run();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.question).toBeNull();
  expect(tuples(submissions).map((tuple) => tuple[2])).toEqual(['a', 'b', 'c']);
});
it('accepts the reviewer separating obligations after later decisive evidence', async () => {
  prepare([
    msg('a', null, 'accepted:alpha|Send the report'),
    msg('b', 'a', 'accepted:beta|Send the other report'),
    msg('c', 'b', 'correction:resolved|The second report is for Bob, not Alice'),
  ]);
  scenario(({ evidence }) => ({
    records: [
      captureRecord(
        'alice',
        [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
        [state('c', 'Send Alice the report')],
      ),
      captureRecord(
        'bob',
        evidence.slice(1).map((entry, index) => ({
          kind: index ? 'correction' : 'accepted',
          reference: captureReference(entry),
        })),
        [state('c', 'Send Bob the report')],
      ),
    ],
    dispositions: [
      captureDisposition(['alice'], intent('Send Alice the report'), 'First report'),
      captureDisposition(
        ['bob'],
        intent('Send Bob the report'),
        'Second report separated explicitly',
      ),
    ],
  }));
  const submissions = await run();
  expect(submissions).toHaveLength(2);
  expect(submissions.every((item) => item.question === null)).toBe(true);
  expect(tuples(submissions).map((tuple) => tuple[2])).toEqual(['a', 'b', 'c']);
});
it('retains questions when the reviewer cannot assign a bridge between contradictory founders', async () => {
  prepare([
    msg('a', null, 'accepted:Alice|Send Alice the report'),
    msg('b', 'a', 'accepted:Bob|Send Bob the report'),
    msg('c', 'b', 'correction:bridge|Send it Monday'),
  ]);
  scenario(({ evidence }) => ({
    records: evidence.map((entry, index) =>
      captureRecord(
        String(index),
        [{ kind: index === 2 ? 'correction' : 'accepted', reference: captureReference(entry) }],
        [state('c', ['Alice report', 'Bob report', 'Monday report'][index]!)],
        { ambiguous: true },
      ),
    ),
    dispositions: evidence.map((_, index) =>
      captureDisposition(
        [String(index)],
        intent(
          ['Alice report', 'Bob report', 'Monday report'][index]!,
          'Which report is due Monday?',
        ),
        'Unresolved bridge',
      ),
    ),
  }));
  const submissions = await run();
  expect(submissions).toHaveLength(3);
  expect(submissions.every((item) => !!item.question)).toBe(true);
});
it('rejects coerced declared match enums at submission', async () => {
  prepare([msg('a', null, 'accepted:report|Send the report')]);
  const uuid = '12345678-1234-1234-1234-123456789abc';
  vi.mocked(readTaskCatalog).mockResolvedValue([
    { uuid, status: 'pending', description: 'Report' },
  ]);
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_tasks', {});
    return {
      records: [
        captureRecord(
          'report',
          [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
          [state('a', 'Report')],
          { candidates: [{ kind: 'task', id: uuid, judgment: ['same'] as unknown as string }] },
        ),
      ],
      dispositions: [captureDisposition(['report'], intent('Report'), 'Invalid judgment')],
    };
  });
  await expect(run()).rejects.toThrow('Invalid capture candidate judgment');
});
it('rejects out-of-order evidence continuation without acknowledging delivery', async () => {
  prepare([msg('a', null, '😀'.repeat(40000))]);
  runner.mockImplementation(async (input) => {
    const paths = reviewerPaths(input.instruction);
    const tool = input.tools.find((tool) => tool.name === 'remembrancer_read')!;
    const skill = await tool.execute(
      'skill',
      { path: paths.skill },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    input.acceptToolResult?.(skill);
    await tool.execute(
      'skip',
      { path: paths.review, page: 1 },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
  });
  await expect(run()).rejects.toThrow('next evidence page in order');
  expect(() => current.completion([])).toThrow('Read all evidence pages');
});
it('allows distinct reviewer records on the same exact span, preserving every branch occurrence', async () => {
  const quote = 'I will send Alice and Bob the report.';
  prepare([msg('root', null, quote), msg('a', 'root', 'Context A'), msg('b', 'root', 'Context B')]);
  scenario(({ evidence }) => {
    const refs = evidence
      .filter((entry) => entry.entryId === 'root')
      .map((entry) => ({ kind: 'accepted', reference: captureReference(entry) }));
    return {
      records: ['Alice', 'Bob'].map((name) =>
        captureRecord(
          name,
          refs,
          ['a', 'b'].map((branchId) => state(branchId, `Send ${name} the report`)),
        ),
      ),
      dispositions: ['Alice', 'Bob'].map((name) =>
        captureDisposition([name], intent(`Send ${name} the report`), 'Two named recipients'),
      ),
    };
  });
  const submissions = await run();
  expect(submissions).toHaveLength(2);
  expect(tuples(submissions)).toEqual(
    ['a', 'b', 'a', 'b'].map((branchId) => ['session', branchId, 'root', null, 0, quote]),
  );
});
it('delivers the exact founding span and later correction, not retained finding handles', async () => {
  const quote = 'I will ' + 'send the report '.repeat(180);
  prepare([msg('a', null, quote), msg('b', 'a', 'correction:report|Monday')]);
  scenario(({ evidence }) => {
    expect(evidence[0]!.text).toBe(quote);
    return {
      records: [
        captureRecord(
          'report',
          evidence.map((entry, index) => ({
            kind: index ? 'correction' : 'accepted',
            reference: captureReference(entry),
          })),
          [state('b', 'Send the report Monday')],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['report'],
          intent('Send the report Monday'),
          'Correction to exact founder',
        ),
      ],
    };
  });
  expect(tuples(await run())[0]).toEqual(['session', 'b', 'a', null, 0, quote]);
});
it('preserves equal-text edit identities, redactions and UTF-16 offsets in delivered evidence', async () => {
  prepare([
    msg('root', null, 'Removed secret'),
    { type: 'context_edit', id: 'redact', parentId: 'root', targetId: 'root', replacement: null },
    msg('intent', 'redact', '😀 Send café'),
    {
      type: 'context_edit',
      id: 'edit1',
      parentId: 'intent',
      targetId: 'intent',
      replacement: { content: '😀 Send café' },
    },
    msg('a', 'edit1', 'A'),
    {
      type: 'context_edit',
      id: 'edit2',
      parentId: 'intent',
      targetId: 'intent',
      replacement: { content: '😀 Send café' },
    },
    msg('b', 'edit2', 'B'),
  ]);
  scenario(({ evidence }) => {
    expect(evidence.some((entry) => entry.text.includes('Removed secret'))).toBe(false);
    const edited = evidence.filter((entry) => entry.entryId === 'intent');
    expect(edited.map((entry) => entry.editId)).toEqual(['edit1', 'edit2']);
    return {
      records: [
        captureRecord(
          'cafe',
          edited.map((entry) => ({ kind: 'accepted', reference: captureReference(entry, 3) })),
          ['a', 'b'].map((branchId) => state(branchId, 'Send café')),
        ),
      ],
      dispositions: [
        captureDisposition(['cafe'], intent('Send café'), 'Same text, distinct edits'),
      ],
    };
  });
  expect(tuples(await run())).toEqual([
    ['session', 'a', 'intent', 'edit1', 3, 'Send café'],
    ['session', 'b', 'intent', 'edit2', 3, 'Send café'],
  ]);
});
