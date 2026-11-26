import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { CaptureArtifacts } from '../extensions/remembrancer/capture-artifacts.js';
import * as captureReviewer from '../extensions/remembrancer/capture.js';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { captureExtension } from './fixtures/capture-extension.js';
import { runReviewer } from '../extensions/remembrancer/reviewer.js';
import {
  answerCaptureReview,
  captureDisposition,
  captureRecord,
  captureReference,
  type CaptureScenario,
  type CaptureRecord,
} from './fixtures/capture-reviewer.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import { detailPages } from '../extensions/remembrancer/review-findings.js';
import { estimateReviewerTokens } from '../extensions/remembrancer/reviewer-budget.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';

vi.mock('../extensions/remembrancer/reviewer.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/reviewer.js')>()),
  runReviewer: vi.fn(),
}));
vi.mock('../extensions/remembrancer/capture-worker.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/capture-worker.js')>()),
  launchCaptureWorker: vi.fn().mockResolvedValue(123),
}));
vi.mock('../extensions/remembrancer/taskwarrior.js', async (original) => ({
  ...(await original<typeof import('../extensions/remembrancer/taskwarrior.js')>()),
  readTaskCatalog: vi.fn().mockResolvedValue([]),
}));
let dir: string;
let file: string;
let ctx: ExtensionContext;
let db: CheckpointStore;
let handlers: ReturnType<typeof captureExtension>['handlers'];
let fixture: ReturnType<typeof captureExtension>;
let config: ReturnType<typeof captureExtension>['settings'];
const runner = vi.mocked(runReviewer);
const intent = (description: string, question: string | null = null) => ({
  change: { operation: 'add' as const, fields: { description }, annotations: [] },
  question,
  explanation: 'Reviewer-finalized obligation',
});
const state = (branchId: string, description: string, status = 'active') => ({
  branchId,
  state: {
    summary: description,
    status,
    draft: { change: intent(description).change, question: null },
  },
});
function scenario(answer: CaptureScenario) {
  runner.mockImplementation((input) => answerCaptureReview(input, answer));
}
function message(id: string, parentId: string | null, content: string) {
  return (
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: '2026-11-01T00:00:00Z',
      message: { role: 'user', content },
    }) + '\n'
  );
}
function transcript(entries: [string, string | null, string][]) {
  writeFileSync(
    file,
    JSON.stringify({ type: 'session', id: 'outgoing', cwd: dir }) +
      '\n' +
      entries.map((entry) => message(...entry)).join(''),
  );
}
async function capture(options: Partial<Parameters<typeof runCaptureWorker>[0]> = {}) {
  const inbox = join(dirname(db.file), 'capture-inbox');
  const accepted = await preserveHandoff({
    id: randomUUID(),
    inbox,
    source: { file, sessionId: 'outgoing' },
    execution: captureExecution(ctx),
  });
  await runCaptureWorker({ database: db.file, inbox, ...options });
  return accepted.manifest.id;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture = captureExtension(true);
  ({ dir, file, ctx, handlers, settings: config } = fixture);
  db = fixture.db!;
  config({ autoCapture: true });
  scenario(async ({ evidence, lookup }) => {
    await lookup('remembrancer_tasks', { query: 'comparison' });
    const promise = evidence.find((entry) => entry.entryId === 'promise');
    return promise
      ? {
          records: [
            captureRecord(
              'comparison',
              [{ kind: 'accepted', reference: captureReference(promise) }],
              [state(promise.branchId, 'Send Maya the comparison')],
            ),
          ],
          dispositions: [
            captureDisposition(
              ['comparison'],
              intent('Send Maya the comparison'),
              'Accepted outgoing obligation',
            ),
          ],
        }
      : { records: [], dispositions: [] };
  });
  vi.mocked(readTaskCatalog).mockResolvedValue([]);
  vi.mocked(launchCaptureWorker).mockResolvedValue(123);
});
afterEach(async () => fixture.close(ctx));

it('captures only outgoing frozen evidence and skips model work for covered scope', async () => {
  db.enroll('other', '/must-not-read');
  const enrolled = db.sources();
  const settings = readFileSync(join(dir, 'agent', 'settings.json'), 'utf8');
  await capture();
  const calls = runner.mock.calls.length;
  const coveredId = await capture();
  expect(runner).toHaveBeenCalledTimes(calls);
  expect(db.captureJob(coveredId)?.state).toBe('completed');
  expect(db.reviewed().map((item) => item.sessionId)).toEqual(['outgoing']);
  expect(db.proposals()).toHaveLength(1);
  expect(db.sources().find((source) => source.sessionId === 'other')).toEqual(enrolled[0]);
  expect(readFileSync(join(dir, 'agent', 'settings.json'), 'utf8')).toBe(settings);
  expect(runner.mock.calls.every(([input]) => input.sessionId === 'outgoing')).toBe(true);
  expect(
    runner.mock.calls.every(
      ([input]) =>
        input.tools.map((tool) => tool.name).join() ===
        'remembrancer_read,remembrancer_context,remembrancer_tasks,remembrancer_proposals,remembrancer_submit',
    ),
  ).toBe(true);
  expect(readTaskCatalog).toHaveBeenCalledWith(undefined, {
    cwd: dir,
    signal: expect.any(AbortSignal),
  });
});
it('rejects malformed saved scope before model work and preserves other enrolled defaults/settings', async () => {
  const otherFile = join(dir, 'unread-other.jsonl');
  writeFileSync(otherFile, 'broken archive\n');
  db.enroll('other', otherFile);
  const other = db.sources();
  const settings = readFileSync(join(dir, 'agent', 'settings.json'), 'utf8');
  appendFileSync(file, '{broken json\n');
  const id = await capture();
  expect(runner).not.toHaveBeenCalled();
  expect(db.reviewed()).toEqual([]);
  expect(db.proposals()).toEqual([]);
  expect(db.sources()).toEqual(other);
  expect(readFileSync(join(dir, 'agent', 'settings.json'), 'utf8')).toBe(settings);
  expect(db.captureJob(id)?.state).toBe('failed');
});
it.each(['catalogue', 'cached candidate'])(
  'retains published state on stale %s and retries the whole continuing attempt',
  async (when) => {
    await capture();
    const original = db.proposals()[0]!;
    db.editProposal(original.id, original.revision, {
      change: {
        operation: 'add',
        fields: { description: 'Long saved draft '.repeat(10000) },
        annotations: [],
      },
      expected: null,
      question: 'Keep saved draft?',
    });
    const before = {
      proposals: db.proposals(),
      coverage: db.reviewed(),
      notice: db.proposalNotice(),
    };
    appendFileSync(file, message('later', 'promise', 'I sent the unrelated later comparison.'));
    let changed = false;
    const originalGeneration = CheckpointStore.prototype.contextGeneration;
    const generation = vi
      .spyOn(CheckpointStore.prototype, 'contextGeneration')
      .mockImplementation(function (this: CheckpointStore) {
        return originalGeneration.call(this) + Number(changed);
      });
    const originalList = CheckpointStore.prototype.proposals;
    const list = vi.spyOn(CheckpointStore.prototype, 'proposals').mockImplementation(function (
      this: CheckpointStore,
      ...args
    ) {
      const page = originalList.apply(this, args);
      if (when === 'catalogue') changed = true;
      return page;
    });
    scenario(async ({ lookup }) => {
      const page = await lookup<{ proposals: { id: string; revision: number }[] }>(
        'remembrancer_proposals',
        {},
      );
      changed = true;
      await lookup('remembrancer_proposals', {
        action: 'detail',
        id: page.proposals[0]!.id,
        revision: page.proposals[0]!.revision,
      });
      throw new Error('Stale lookup accepted');
    });
    const id = await capture();
    expect(db.captureJob(id)).toMatchObject({
      state: 'failed',
      attemptCount: 1,
      retryEligible: true,
    });
    expect(changed).toBe(true);
    expect(new Set(generation.mock.results.map((result) => result.value)).size).toBe(2);
    generation.mockRestore();
    list.mockRestore();
    expect({
      proposals: db.proposals(),
      coverage: db.reviewed(),
      notice: db.proposalNotice(),
    }).toEqual(before);
    const saved = db.proposals()[0]!;
    const edited = db.editProposal(saved.id, saved.revision, {
      ...saved.draft!,
      question: 'Fresh state for whole retry',
    });
    const proposals = db.proposals();
    let sawFresh = false;
    scenario(async ({ evidence, lookup }) => {
      let request: object | null = { action: 'detail', id: edited.id, revision: edited.revision };
      let json = '';
      while (request) {
        const page: { json: string; next: object | null } = await lookup(
          'remembrancer_proposals',
          request,
        );
        json += page.json;
        request = page.next;
      }
      sawFresh = (JSON.parse(json) as Proposal).draft!.question === 'Fresh state for whole retry';
      return {
        records: [
          captureRecord(
            'later',
            [{ kind: 'completion', reference: captureReference(evidence[0]!) }],
            [state(evidence[0]!.branchId, 'Unrelated later comparison', 'completed')],
            {
              candidates: [
                {
                  kind: 'proposal',
                  id: edited.id,
                  revision: edited.revision,
                  judgment: 'different',
                },
              ],
            },
          ),
        ],
        dispositions: [captureDisposition(['later'], null, 'Untracked unrelated completion')],
      };
    });
    const calls = runner.mock.calls.length;
    const inbox = join(dirname(db.file), 'capture-inbox');
    await runCaptureWorker({ database: db.file, inbox });
    expect(runner).toHaveBeenCalledTimes(calls);
    vi.spyOn(Date, 'now').mockReturnValue(db.captureJob(id)!.nextAttemptAt!);
    await runCaptureWorker({ database: db.file, inbox });
    expect(sawFresh).toBe(true);
    expect(db.proposal(edited.id)?.revision).toBe(edited.revision);
    expect(db.captureJob(id)).toMatchObject({ state: 'completed', attemptCount: 2 });
    expect(db.proposals()).toEqual(proposals);
    expect(db.reviewed().map((row) => row.entryId)).toEqual(['promise', 'later']);
  },
);
it('revises a differently labelled saved proposal from its exact edited draft without duplicating it', async () => {
  await capture();
  const first = db.proposals()[0]!;
  const edited = db.editProposal(first.id, first.revision, {
    change: {
      operation: 'add',
      fields: { description: 'Send the deployment report' },
      annotations: [],
    },
    expected: null,
    question: 'Keep my edited wording?',
  });
  appendFileSync(
    file,
    message('deployment', 'promise', 'accepted:deployment|Send the deployment report'),
  );
  let readExact = false;
  scenario(async ({ evidence, lookup }) => {
    const page = await lookup<{ json: string; next: unknown }>('remembrancer_proposals', {
      action: 'detail',
      id: edited.id,
      revision: edited.revision,
    });
    expect(page.next).toBeNull();
    const detail = JSON.parse(page.json) as Proposal;
    readExact =
      detail.draft?.change.operation === 'add' &&
      detail.draft.change.fields.description === 'Send the deployment report';
    return {
      records: [
        captureRecord(
          'deployment',
          [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
          [state(evidence[0]!.branchId, 'Send the deployment report')],
          {
            candidates: [
              { kind: 'proposal', id: detail.id, revision: detail.revision, judgment: 'same' },
            ],
          },
        ),
      ],
      dispositions: [
        captureDisposition(
          ['deployment'],
          {
            change: detail.draft!.change,
            question: detail.draft!.question,
            explanation: 'Preserve edited deployment wording',
          },
          'Same edited obligation',
        ),
      ],
    };
  });
  await capture();
  expect(readExact).toBe(true);
  expect(db.proposals()).toHaveLength(1);
  expect(db.proposals()[0]).toMatchObject({
    id: edited.id,
    revision: edited.revision + 1,
    change: edited.draft!.change,
  });
  expect(db.proposals()[0]!.sources.map((source) => source.entryId)).toEqual([
    'promise',
    'deployment',
  ]);
});
it.each(['missing disposition', 'duplicate disposition', 'unknown record'])(
  'rejects %s rather than silently losing a declared record',
  async (failure) => {
    scenario(({ evidence }) => {
      const records = [
        captureRecord(
          'one',
          [{ kind: 'accepted', reference: captureReference(evidence[0]!) }],
          [state(evidence[0]!.branchId, 'Comparison')],
        ),
      ];
      const outcome = captureDisposition(['one'], intent('Comparison'), 'Accepted');
      return {
        records,
        dispositions:
          failure === 'missing disposition'
            ? []
            : failure === 'duplicate disposition'
              ? [outcome, outcome]
              : [captureDisposition(['unknown'], null, 'Unknown')],
      };
    });
    const id = await capture();
    expect(db.captureJob(id)?.state).toBe('failed');
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
  },
);
it('delivers every Unicode fragment and accepts agent-declared no commitments', async () => {
  const text = '😀\\"\n'.repeat(20000);
  transcript([['long', null, text]]);
  scenario(({ evidence }) => {
    expect(evidence.length).toBeGreaterThan(1);
    expect(evidence.map((entry) => entry.text).join('')).toBe(text);
    for (const entry of evidence)
      expect(entry.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    return { records: [], dispositions: [] };
  });
  await capture();
  expect(db.reviewed()).toHaveLength(1);
  expect(db.proposals()).toEqual([]);
});
it('retains reviewer-folded distant corrections, repeated intent and completion', async () => {
  const entries: [string, string | null, string][] = [['a', null, 'accepted:alpha|Friday']];
  let parent = 'a';
  for (let index = 0; index < 20; index++) {
    const id = `gap${index}`;
    entries.push([id, parent, 'padding '.repeat(80)]);
    parent = id;
  }
  entries.push(
    ['correction', parent, 'correction:alpha|Monday'],
    ['repeat', 'correction', 'accepted:alpha|Monday'],
  );
  transcript(entries);
  scenario(({ evidence }) => {
    const relevant = evidence.filter((entry) =>
      ['a', 'repeat', 'correction', 'done'].includes(entry.entryId),
    );
    const done = relevant.some((entry) => entry.entryId === 'done');
    return {
      records: [
        captureRecord(
          'alpha',
          relevant.map((entry) => ({
            kind: entry.text.split(':')[0]!,
            reference: captureReference(entry),
          })),
          [state(evidence[0]!.branchId, 'Monday', done ? 'completed' : 'active')],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['alpha'],
          done ? null : intent('Monday'),
          'Distant correction and repeat are the same obligation',
        ),
      ],
    };
  });
  await capture();
  expect(db.proposals()).toHaveLength(1);
  expect(db.proposals()[0]!.change).toMatchObject({ fields: { description: 'Monday' } });
  expect(
    db
      .proposals()[0]!
      .sources.map((item) => item.entryId)
      .sort(),
  ).toEqual(['a', 'correction', 'repeat']);
  transcript([...entries, ['done', 'repeat', 'completion:alpha|done']]);
  const independent = new CheckpointStore(join(dir, 'independent.sqlite'));
  const inbox = join(dir, 'independent-inbox');
  await preserveHandoff({
    id: 'completion',
    inbox,
    source: { file, sessionId: 'outgoing' },
    execution: captureExecution(ctx),
  });
  try {
    await runCaptureWorker({ database: independent.file, inbox });
    expect(independent.proposals()).toEqual([]);
    expect(independent.reviewed()).toHaveLength(1);
  } finally {
    independent.close();
  }
});
it('retains reviewer-resolved pronouns and conflicting sibling changes as a question', async () => {
  transcript([
    ['pronoun', null, 'reference:it|actually Monday'],
    ['intent', 'pronoun', 'accepted:alpha|Friday'],
    ['left', 'intent', 'correction:alpha|Monday'],
    ['right', 'intent', 'correction:alpha|Tuesday'],
  ]);
  scenario(({ evidence }) => {
    expect(
      evidence.filter((entry) => entry.entryId === 'intent').map((entry) => entry.branchId),
    ).toEqual(['left', 'right']);
    return {
      records: [
        captureRecord(
          'alpha',
          evidence.map((entry) => ({
            kind: entry.text.split(':')[0]!,
            reference: captureReference(entry),
          })),
          [state('left', 'Monday'), state('right', 'Tuesday')],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['alpha'],
          intent('Monday', 'Monday or Tuesday?'),
          'Sibling corrections conflict',
        ),
      ],
    };
  });
  await capture();
  expect(db.proposals()).toHaveLength(1);
  expect(db.proposals()[0]!.question).toBe('Monday or Tuesday?');
  expect(new Set(db.proposals()[0]!.sources.map((source) => source.branchId))).toEqual(
    new Set(['left', 'right']),
  );
});
it.each(['refusal', 'reference'])(
  'keeps %s outcomes behind a reviewer-supplied question',
  async (kind) => {
    transcript(
      kind === 'refusal'
        ? [
            ['intent', null, 'accepted:alpha|Send alpha'],
            ['refusal', 'intent', 'refusal:alpha|Do not send it'],
          ]
        : [['unresolved', null, 'reference:it|done']],
    );
    scenario(({ evidence }) => ({
      records: [
        captureRecord(
          'alpha',
          evidence.map((entry) => ({
            kind: entry.text.split(':')[0]!,
            reference: captureReference(entry),
          })),
          [
            state(
              evidence[0]!.branchId,
              'Send alpha',
              kind === 'refusal' ? 'refused' : 'uncertain',
            ),
          ],
        ),
      ],
      dispositions: [
        captureDisposition(
          ['alpha'],
          intent(
            'Send alpha',
            kind === 'refusal' ? 'Should this be cancelled?' : 'Which obligation was completed?',
          ),
          'Unresolved interpretation',
        ),
      ],
    }));
    await capture();
    expect(db.proposals()).toHaveLength(1);
    expect(db.proposals()[0]!.question).toBeTruthy();
  },
);
it('accepts many explicitly declared commitments and one growing correction history without a host output catalogue', async () => {
  const entries: [string, string | null, string][] = [];
  let parent: string | null = null;
  for (let index = 0; index < 80; index++) {
    const id = `intent${index}`;
    entries.push([id, parent, `accepted:task${index}|Do task ${index}`]);
    parent = id;
  }
  for (let index = 0; index < 25; index++) {
    const id = `update${index}`;
    entries.push([id, parent, `correction:task0|Update ${index}`]);
    parent = id;
  }
  transcript(entries);
  ctx = { ...ctx, model: { ...ctx.model!, contextWindow: 22000, maxTokens: 4096 } };
  scenario(({ evidence }) => ({
    records: Array.from({ length: 80 }, (_, index) =>
      captureRecord(
        `task${index}`,
        evidence
          .filter(
            (entry) =>
              entry.entryId === `intent${index}` ||
              (index === 0 && entry.entryId.startsWith('update')),
          )
          .map((entry) => ({
            kind: entry.entryId.startsWith('update') ? 'correction' : 'accepted',
            reference: captureReference(entry),
          })),
        [state(evidence[0]!.branchId, index === 0 ? 'Update 24' : `Do task ${index}`)],
      ),
    ),
    dispositions: Array.from({ length: 80 }, (_, index) =>
      captureDisposition(
        [`task${index}`],
        intent(index === 0 ? 'Update 24' : `Do task ${index}`),
        'Reviewer-finalized commitment',
      ),
    ),
  }));
  await capture();
  expect(db.proposalCount()).toBe(80);
  expect(
    db.proposals(undefined, 0, 100).find((item) => item.sources.length > 1)!.sources,
  ).toHaveLength(26);
  expect(runner).toHaveBeenCalledOnce();
  expect(runner.mock.calls[0]![0].instruction).not.toContain('"proposals":[');
});
it.each(['early evidence', 'matching', 'cleanup', 'pre-publication'])(
  'commits nothing after %s failure',
  async (failure) => {
    transcript([
      ['a', null, 'accepted:alpha|Send alpha'],
      ['b', 'a', 'accepted:beta|Send beta'],
    ]);
    const before = { sources: db.sources(), notice: db.proposalNotice() };
    let injected = false;
    scenario(async ({ evidence, lookup }) => {
      if (failure === 'matching') {
        await lookup('remembrancer_tasks', {});
        injected = true;
        throw new Error('fixture matching failed');
      }
      expect(db.proposals()).toEqual([]);
      expect(db.reviewed()).toEqual([]);
      return {
        records: evidence.map((entry, index) =>
          captureRecord(
            String(index),
            [{ kind: 'accepted', reference: captureReference(entry) }],
            [state(entry.branchId, index ? 'Send beta' : 'Send alpha')],
          ),
        ),
        dispositions: evidence.map((_, index) =>
          captureDisposition(
            [String(index)],
            intent(index ? 'Send beta' : 'Send alpha'),
            'Accepted',
          ),
        ),
      };
    });
    if (failure === 'early evidence')
      runner.mockImplementation(async () => {
        injected = true;
        throw new Error('fixture evidence failed');
      });
    if (failure === 'cleanup') {
      const dispose = CaptureArtifacts.prototype.dispose;
      vi.spyOn(CaptureArtifacts.prototype, 'dispose').mockImplementation(function (
        this: CaptureArtifacts,
      ) {
        dispose.call(this);
        injected = true;
        throw new Error('fixture cleanup failed');
      });
    }
    const publication = vi.spyOn(CheckpointStore.prototype, 'finishCaptureJob');
    if (failure === 'pre-publication')
      publication.mockImplementationOnce((_owner, _attempt, submissions) => {
        expect(submissions.map((item) => item.change)).toEqual([
          intent('Send alpha').change,
          intent('Send beta').change,
        ]);
        expect(submissions.every((item) => item.references.length === 1)).toBe(true);
        injected = true;
        throw Object.assign(new Error('fixture publication failed'), { code: 'EIO' });
      });
    const id = await capture();
    expect(injected).toBe(true);
    expect(db.captureJob(id)?.state).toBe('failed');
    if (failure === 'pre-publication') {
      expect(publication).toHaveBeenCalledOnce();
      expect(db.captureJob(id)?.diagnostic).toContain(
        'Capture atomic-publication: execution-failure (EIO)',
      );
    } else expect(publication).not.toHaveBeenCalled();
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
    expect({ sources: db.sources(), notice: db.proposalNotice() }).toEqual(before);
    db.claimReview();
    db.releaseReview();
  },
);
it.each(['applying', 'uncertain'] as const)(
  'publishes nothing, including an unrelated declared add, when a %s match is unresolved',
  async (savedState) => {
    await capture();
    const saved = db.proposals()[0]!;
    const claimed = db.claimProposal(saved.id, saved.revision);
    if (savedState === 'uncertain')
      db.recordProposalResult(claimed.id, claimed.revision, claimed.claim!, {
        state: savedState,
        verified: null,
        error: 'Synthetic unresolved outcome',
      });
    const before = {
      proposals: db.proposals(),
      coverage: db.reviewed(),
      sources: db.sources(),
      notice: db.proposalNotice(),
      generation: db.contextGeneration(),
    };
    appendFileSync(
      file,
      message('unrelated', 'promise', 'accepted:separate|Send separate report') +
        message('repeat', 'unrelated', 'accepted:comparison|Send Maya the comparison'),
    );
    scenario(async ({ evidence, lookup }) => {
      const page = await lookup<{ proposals: { id: string; revision: number }[] }>(
        'remembrancer_proposals',
        {},
      );
      const candidate = page.proposals[0]!;
      const records: CaptureRecord[] = evidence.map((entry, index) =>
        captureRecord(
          String(index),
          [{ kind: 'accepted', reference: captureReference(entry) }],
          [state(entry.branchId, index ? 'Send Maya the comparison' : 'Send separate report')],
          {
            candidates: index
              ? [
                  {
                    kind: 'proposal',
                    id: candidate.id,
                    revision: candidate.revision,
                    judgment: 'same',
                  },
                ]
              : [],
          },
        ),
      );
      return {
        records,
        dispositions: [
          captureDisposition(['0'], intent('Send separate report'), 'Separate obligation'),
          captureDisposition(
            ['1'],
            intent('Send Maya the comparison'),
            'Unresolved saved application',
          ),
        ],
      };
    });
    const review = vi.spyOn(captureReviewer, 'reviewPreparedCapture');
    const publication = vi.spyOn(CheckpointStore.prototype, 'finishCaptureJob');
    const id = await capture();
    expect(review).toHaveBeenCalledOnce();
    await expect(review.mock.results[0]!.value).rejects.toThrow('verify-only');
    expect(publication).not.toHaveBeenCalled();
    expect(db.captureJob(id)?.state).toBe('failed');
    expect({
      proposals: db.proposals(),
      coverage: db.reviewed(),
      sources: db.sources(),
      notice: db.proposalNotice(),
      generation: db.contextGeneration(),
    }).toEqual(before);
  },
);
it('keeps late appends/edits outside scope and never rereads live history', async () => {
  let changed = false;
  const answer = runner.getMockImplementation()!;
  runner.mockImplementation(async (input) => {
    if (!changed) {
      appendFileSync(
        file,
        JSON.stringify({
          type: 'context_edit',
          id: 'edit',
          parentId: 'promise',
          targetId: 'promise',
          replacement: { content: 'Edited after freeze' },
        }) +
          '\n' +
          message('later', 'edit', 'Late append'),
      );
      changed = true;
    }
    return answer(input);
  });
  await capture();
  expect(db.proposals()[0]!.sources[0]!.quote).toBe('Send Maya the comparison');
  const next = prepareReview([{ file, sessionId: 'outgoing' }], db.reviewed());
  expect(next.evidence.map((item) => item.text)).toEqual(['Edited after freeze', 'Late append']);
});
it('host pages exact oversized structured fields preserving Unicode and offsets', () => {
  const original = '😀\\"\n'.repeat(10000);
  const envelope = (page: object, index: number) => ({ page, index, notes: 'Exact field' });
  const pages = [...detailPages({ draft: { explanation: original } }, 512, [], envelope)] as {
    path: string[];
    offset: number;
    text: string;
    end: boolean;
  }[];
  for (const [index, page] of pages.entries()) {
    expect(estimateReviewerTokens(envelope(page, index))).toBeLessThanOrEqual(512);
    expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    expect(page.end).toBe(page.offset + page.text.length === original.length);
  }
  expect(pages.map((page) => page.text).join('')).toBe(original);
  expect(pages.every((page) => page.path.join('.') === 'draft.explanation')).toBe(true);
  expect(
    pages.every(
      (page, index) =>
        page.offset === pages.slice(0, index).reduce((sum, item) => sum + item.text.length, 0),
    ),
  ).toBe(true);
});
it('manual foreground remains begin/next/finish with checkpoint-only finish', async () => {
  await capture();
  const saved = db.proposals();
  config({ autoCapture: false });
  ctx = { ...ctx, mode: 'print', hasUI: false };
  await handlers.get('session_start')!({}, ctx);
  const tool = fixture.tools.find((item) => item.name === 'remembrancer_review')!;
  const call = async (args: object) => {
    const result = await tool.execute('manual', args, undefined, undefined, ctx);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  let batch = await call({ action: 'begin' });
  expect(batch.groups).toEqual([]);
  await call({ action: 'finish', batch: batch.batch });
  appendFileSync(file, message('later', 'promise', 'A manual obligation'));
  batch = await call({ action: 'begin' });
  expect(batch.groups[0].entries[0].entryId).toBe('later');
  const reviewed = db.reviewed();
  const sources = db.sources();
  const notice = db.proposalNotice();
  expect(reviewed.map((row) => row.entryId)).toEqual(['promise']);
  await call({ action: 'finish', batch: batch.batch });
  expect(db.reviewed()).toEqual([...reviewed, { ...reviewed[0]!, entryId: 'later' }]);
  expect(db.proposals()).toEqual(saved);
  expect(db.sources()).toEqual(sources);
  expect(db.proposalNotice()).toEqual(notice);
});
it.each(['empty', 'tool-only', 'covered'])(
  'makes no reviewer request and completes %s scope',
  async (kind) => {
    if (kind !== 'covered') transcript([]);
    if (kind === 'tool-only')
      appendFileSync(
        file,
        JSON.stringify({
          type: 'message',
          id: 'tool',
          parentId: null,
          message: { role: 'toolResult', content: 'ignored' },
        }) + '\n',
      );
    if (kind === 'covered') {
      const prepared = prepareReview([{ file, sessionId: 'outgoing' }], []);
      db.claimReview();
      db.finish({
        sources: prepared.successfulSources,
        sourceDefaults: prepared.sourceDefaults,
        checkpoints: prepared.checkpoints,
      });
      db.releaseReview();
    }
    const before = {
      reviewed: db.reviewed(),
      proposals: db.proposals(),
      sources: db.sources(),
      notice: db.proposalNotice(),
    };
    const id = await capture();
    expect(runner).not.toHaveBeenCalled();
    expect(db.captureJob(id)).toMatchObject({ state: 'completed', attemptCount: 1 });
    expect({
      reviewed: db.reviewed(),
      proposals: db.proposals(),
      sources: db.sources(),
      notice: db.proposalNotice(),
    }).toEqual(before);
  },
);
it.each(['capture', 'release', 'close'])(
  'reports safe shutdown %s diagnostics and still closes the database',
  async (phase) => {
    const error = Object.assign(new Error('SECRET provider body and !credential-command'), {
      code: 'EACCES',
      cause: new Error('SECRET nested credentials'),
    });
    await handlers.get('session_start')!({}, ctx);
    const originalClose = CheckpointStore.prototype.close;
    const close = vi.spyOn(CheckpointStore.prototype, 'close');
    if (phase === 'capture') vi.mocked(launchCaptureWorker).mockRejectedValue(error);
    if (phase === 'release')
      vi.spyOn(CheckpointStore.prototype, 'releaseReview').mockImplementationOnce(() => {
        throw error;
      });
    if (phase === 'close') {
      config({ autoCapture: false });
      close.mockImplementationOnce(function (this: CheckpointStore) {
        originalClose.call(this);
        throw error;
      });
    }
    await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
    const expectedPhase = {
      capture: 'worker-launch',
      release: 'manual-release',
      close: 'foreground-close',
    }[phase];
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Capture ${expectedPhase}: shutdown-failed (EACCES)`),
      'warning',
    );
    expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).not.toMatch(
      /SECRET|provider body|credential-command|contention/,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(db.reviewed()).toEqual([]);
    expect(db.proposals()).toEqual([]);
    db.claimReview();
    db.releaseReview();
  },
);
it.each(['SECRET non-Error provider failure', { code: 'ENOSPC', message: 'SECRET command' }])(
  'does not expose arbitrary rejected values in shutdown diagnostics: %j',
  async (failure) => {
    vi.mocked(launchCaptureWorker).mockRejectedValue(failure);
    await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Capture worker-launch: shutdown-failed'),
      'warning',
    );
    const diagnostics = JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls);
    expect(diagnostics).not.toMatch(/SECRET|command|contention/);
    if (typeof failure === 'object') expect(diagnostics).toContain('ENOSPC');
  },
);
it('closes the shutdown database even when failure notification throws', async () => {
  await handlers.get('session_start')!({}, ctx);
  const close = vi.spyOn(CheckpointStore.prototype, 'close');
  vi.mocked(launchCaptureWorker).mockRejectedValue(new Error('launch failed'));
  vi.mocked(ctx.ui.notify).mockImplementation(() => {
    throw new Error('notice failed');
  });
  await expect(handlers.get('session_shutdown')!({ reason: 'quit' }, ctx)).rejects.toThrow(
    'notice failed',
  );
  expect(close).toHaveBeenCalledOnce();
  db.claimReview();
  db.releaseReview();
});
