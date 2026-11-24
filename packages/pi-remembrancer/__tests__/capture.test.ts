import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import * as captureReviewer from '../extensions/remembrancer/capture.js';
import { preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import {
  launchCaptureWorker,
  runCaptureWorker,
} from '../extensions/remembrancer/capture-worker.js';
import { captureExecution } from '../extensions/remembrancer/config.js';
import { captureExtension } from './fixtures/capture-extension.js';
import { runReviewerStep } from '../extensions/remembrancer/reviewer.js';
import { captureFields, answerCapture, captureAnswer, stepWork } from './fixtures/capture-steps.js';
import { readTaskCatalog } from '../extensions/remembrancer/taskwarrior.js';
import { detailPages } from '../extensions/remembrancer/review-findings.js';
import { estimateReviewerTokens } from '../extensions/remembrancer/reviewer-budget.js';
import * as proposalReads from '../extensions/remembrancer/proposal-read.js';

vi.mock('../extensions/remembrancer/reviewer.js', () => ({ runReviewerStep: vi.fn() }));
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
const runner = vi.mocked(runReviewerStep);
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
  runner.mockImplementation((input) => answerCapture(input));
  vi.mocked(readTaskCatalog).mockResolvedValue([]);
  vi.mocked(launchCaptureWorker).mockResolvedValue(123);
});
afterEach(async () => fixture.close(ctx));

it('captures only the outgoing frozen session and skips covered evidence', async () => {
  db.enroll('other', '/must-not-read');
  const enrolled = db.sources();
  const settings = readFileSync(join(dir, 'agent', 'settings.json'), 'utf8');
  await capture();
  const calls = runner.mock.calls.length;
  await capture();
  expect(runner).toHaveBeenCalledTimes(calls);
  expect(db.reviewed().map((item) => item.sessionId)).toEqual(['outgoing']);
  expect(db.proposals()).toHaveLength(1);
  expect(db.sources().find((source) => source.sessionId === 'other')).toEqual(enrolled[0]);
  expect(readFileSync(join(dir, 'agent', 'settings.json'), 'utf8')).toBe(settings);
  expect(runner.mock.calls.every(([input]) => input.sessionId === 'outgoing')).toBe(true);
  expect(
    runner.mock.calls.every(
      ([input]) => input.tools.map((tool) => tool.name).join() === 'remembrancer_step',
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
  'retains all published state on a stale typed %s and retries the whole attempt with fresh state',
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
    appendFileSync(
      file,
      message('later', 'promise', 'completion:other|I sent the unrelated later comparison.'),
    );
    const reads = vi.spyOn(proposalReads, 'readProposals');
    const typedReads = vi.spyOn(proposalReads, 'readProposal');
    const originalLookup = CheckpointStore.prototype.proposal;
    const lookup = vi.spyOn(CheckpointStore.prototype, 'proposal');
    let changed = false;
    lookup.mockImplementation(function (this: CheckpointStore, id: string) {
      const saved = originalLookup.call(this, id);
      return saved && changed ? { ...saved, revision: saved.revision + 1 } : saved;
    });
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
    runner.mockImplementation((input) => {
      const work = stepWork(input.instruction);
      if (when === 'cached candidate' && work.catalogue?.[0]?.handle) {
        changed = true;
        return answerCapture(input, { candidates: work.catalogue.map((item) => item.handle) });
      }
      return answerCapture(input);
    });
    const id = await capture();
    expect(db.captureJob(id)).toMatchObject({
      state: 'failed',
      attemptCount: 1,
      retryEligible: true,
    });
    expect(changed).toBe(true);
    if (when === 'cached candidate') {
      expect(typedReads.mock.results.at(-1)).toMatchObject({
        type: 'throw',
        value: expect.objectContaining({ message: expect.stringContaining('Stale proposal') }),
      });
    } else {
      expect(typedReads).not.toHaveBeenCalled();
      expect(new Set(generation.mock.results.map((result) => result.value)).size).toBe(2);
    }
    expect(reads).not.toHaveBeenCalled();
    lookup.mockRestore();
    generation.mockRestore();
    list.mockRestore();
    reads.mockRestore();
    typedReads.mockRestore();
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
    runner.mockImplementation((input) => {
      const work = JSON.parse(
        input.instruction.slice(input.instruction.lastIndexOf('\n') + 1),
      ).work;
      if (JSON.stringify(work).includes('Fresh state for whole retry')) sawFresh = true;
      return answerCapture(input);
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

it('revises a differently labelled saved proposal from its exact edited draft, without duplicating it', async () => {
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
  runner.mockImplementation((input) => {
    const work = JSON.parse(input.instruction.slice(input.instruction.lastIndexOf('\n') + 1)).work;
    let answer = captureAnswer(input.instruction);
    if (work.catalogue?.[0]?.handle) {
      expect(JSON.stringify(work.catalogue)).toContain('Send the deployment report');
      answer = { candidates: work.catalogue.map((item: { handle: string }) => item.handle) };
    }
    if (work.page) {
      const identity = captureFields(work.page).some(
        (field) =>
          field.path.join('.') === 'effective.change.fields.description' &&
          'text' in field &&
          field.text.includes('deployment'),
      );
      readExact ||= identity;
      answer = {
        notes:
          identity || work.notes === 'same deployment' ? 'same deployment' : 'identity unresolved',
      };
    }
    if (input.instruction.includes('All exact candidate fields')) {
      readExact ||=
        work.candidate.effective.change.fields.description === 'Send the deployment report';
      answer = {
        match: readExact ? 'same' : 'different',
        state: { ...work.state, draft: work.candidate.effective },
      };
    }
    return answerCapture(input, answer);
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

it('moves every finding and removes absorbed dispositions before closing a merged record', () => {
  const current = new CaptureReview(prepareReview([{ file, sessionId: 'outgoing' }], []), () => {});
  const range = current.nextExtraction()!;
  current.acceptExtraction(range, ['f1', 'f2', 'f3']);
  current.reconcileFinding('f1', 'r1');
  current.reconcileFinding('f2', 'r2');
  current.mergeRecords('r1', ['r2']);
  expect(() => current.disposeRecord('r2', null)).toThrow('Unknown');
  expect(() => current.finishReconciliation()).toThrow('every');
  current.reconcileFinding('f3', 'r1');
  current.disposeRecord('r1', null);
  expect(() => current.mergeRecords('r1', ['r2'])).toThrow();
  expect(current.finishReconciliation()).toEqual([]);
  expect(() => current.completion([])).not.toThrow();
});

it('keeps extraction acknowledgement separate from complete reconciliation/dispositions', () => {
  const current = new CaptureReview(prepareReview([{ file, sessionId: 'outgoing' }], []), () => {});
  const range = current.nextExtraction()!;
  current.acceptExtraction(range, ['f1']);
  expect(() => current.completion([])).toThrow('reconciliation');
  expect(() => current.finishReconciliation()).toThrow('every');
  current.reconcileFinding('f1', 'r1');
  expect(() => current.finishReconciliation()).toThrow('every');
  current.disposeRecord('r1', null);
  expect(current.finishReconciliation()).toEqual([]);
  expect(() => current.completion([])).not.toThrow();
  expect(() => current.reconcileFinding('f1', 'r1')).toThrow();
});
it('does not drain the legacy cursor, accepts empty findings only after every range', async () => {
  transcript([['long', null, '😀\\"\n'.repeat(1000)]]);
  const page = vi.spyOn(CaptureReview.prototype, 'page').mockImplementation(() => {
    throw new Error('Legacy cursor used');
  });
  runner.mockImplementation((input) =>
    answerCapture(input, captureAnswer(input.instruction, true)),
  );
  await capture();
  const ranges = runner.mock.calls
    .map(([input]) => stepWork(input.instruction).range)
    .filter((range): range is NonNullable<typeof range> => range !== undefined);
  expect(ranges.map((range) => range.text).join('')).toBe('😀\\"\n'.repeat(1000));
  expect(page).not.toHaveBeenCalled();
  expect(db.reviewed()).toHaveLength(1);
  expect(db.proposals()).toEqual([]);
});
it('folds distant corrections, repeated intent and completion into the original record', async () => {
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
  await capture();
  expect(db.proposals()).toHaveLength(1);
  expect(db.proposals()[0]!.change).toMatchObject({ fields: { description: 'Monday' } });
  expect(db.proposals()[0]!.sources.map((item) => item.entryId)).toEqual([
    'a',
    'repeat',
    'correction',
  ]);
  // This later capture matches saved proposals through their read API below; use one
  // frozen attempt here to prove distant completion supersedes a staged add.
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
it('resolves an earlier pronoun against later intent and retains ambiguous sibling changes as a question', async () => {
  transcript([
    ['pronoun', null, 'reference:it|actually Monday'],
    ['intent', 'pronoun', 'accepted:alpha|Friday'],
    ['left', 'intent', 'correction:alpha|Monday'],
    ['right', 'intent', 'correction:alpha|Tuesday'],
  ]);
  await capture();
  expect(db.proposals()).toHaveLength(1);
  expect(db.proposals()[0]!.question).toBeTruthy();
  const extraction = runner.mock.calls
    .map(([input]) => stepWork(input.instruction).range)
    .filter((range): range is NonNullable<typeof range> => range !== undefined);
  expect(extraction.filter((range) => range.occurrences[0]!.entryId === 'intent')).toHaveLength(1);
  expect(
    extraction.find((range) => range.occurrences[0]!.entryId === 'intent')!.occurrenceCount,
  ).toBe(2);
  expect(new Set(db.proposals()[0]!.sources.map((source) => source.branchId))).toEqual(
    new Set(['left', 'right']),
  );
});
it.each(['refusal', 'reference'])(
  'keeps %s outcomes behind a question rather than an unconditional addition',
  async (kind) => {
    transcript(
      kind === 'refusal'
        ? [
            ['intent', null, 'accepted:alpha|Send alpha'],
            ['refusal', 'intent', 'refusal:alpha|Do not send it'],
          ]
        : [['unresolved', null, 'reference:it|done']],
    );
    await capture();
    expect(db.proposals()).toHaveLength(1);
    expect(db.proposals()[0]!.question).toBeTruthy();
  },
);

it('pages many findings and a growing one-obligation history without whole-array model output', async () => {
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
  await capture();
  expect(db.proposalCount()).toBe(80);
  expect(
    db.proposals(undefined, 0, 100).find((item) => item.sources.length > 1)!.sources,
  ).toHaveLength(26);
  expect(runner.mock.calls.every(([input]) => !input.instruction.includes('"proposals":['))).toBe(
    true,
  );
});
it.each(['early extraction', 'reconciliation', 'cleanup', 'pre-publication'])(
  'commits nothing after %s failure',
  async (failure) => {
    transcript([
      ['a', null, 'accepted:alpha|Send alpha'],
      ['b', 'a', 'accepted:beta|Send beta'],
    ]);
    const before = { sources: db.sources(), notice: db.proposalNotice() };
    let calls = 0;
    let injected = false;
    runner.mockImplementation(async (input) => {
      calls++;
      if (failure === 'early extraction' && calls === 2) {
        injected = true;
        throw new Error('fixture extraction failed');
      }
      if (failure === 'reconciliation' && input.instruction.includes('Scan this discovery')) {
        injected = true;
        throw new Error('fixture matching failed');
      }
      const result = await answerCapture(input);
      expect(db.proposals()).toEqual([]);
      expect(db.reviewed()).toEqual([]);
      const work = stepWork(input.instruction);
      if (failure === 'cleanup' && work.observation && !work.catalogue && !work.candidate) {
        injected = true;
        throw new Error('fixture cleanup failed');
      }
      return result;
    });
    const publication = vi.spyOn(CheckpointStore.prototype, 'finishCaptureJob');
    if (failure === 'pre-publication')
      publication.mockImplementationOnce((_owner, _attempt, submissions) => {
        expect(submissions.map((item) => item.change)).toEqual([
          { operation: 'add', fields: { description: 'Send alpha' }, annotations: [] },
          { operation: 'add', fields: { description: 'Send beta' }, annotations: [] },
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
  'publishes nothing, including an unrelated staged add, when a %s match is unresolved',
  async (state) => {
    await capture();
    const saved = db.proposals()[0]!;
    const claimed = db.claimProposal(saved.id, saved.revision);
    if (state === 'uncertain')
      db.recordProposalResult(claimed.id, claimed.revision, claimed.claim!, {
        state,
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
    runner.mockImplementation(async (input) => {
      const work = JSON.parse(input.instruction.split('\n').at(-1)!).work;
      if (work.catalogue?.[0]?.handle)
        return answerCapture(input, {
          candidates:
            work.state.summary === 'comparison'
              ? work.catalogue.map((item: { handle: string }) => item.handle)
              : [],
        });
      if (input.instruction.includes('All exact candidate fields'))
        return answerCapture(input, { match: 'same' });
      return answerCapture(input);
    });
    const review = vi.spyOn(captureReviewer, 'reviewPreparedCapture');
    const disposed = vi.spyOn(CaptureReview.prototype, 'disposeRecord');
    const publication = vi.spyOn(CheckpointStore.prototype, 'finishCaptureJob');
    const id = await capture();
    expect(review).toHaveBeenCalledOnce();
    await expect(review.mock.results[0]!.value).rejects.toThrow('verify-only');
    expect(disposed).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        change: {
          operation: 'add',
          fields: { description: 'Send separate report' },
          annotations: [],
        },
        references: [expect.objectContaining({ entryId: 'unrelated' })],
      }),
    );
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
    return answerCapture(input);
  });
  await capture();
  expect(db.proposals()[0]!.sources[0]!.quote).toBe('Send Maya the comparison');
  const next = prepareReview([{ file, sessionId: 'outgoing' }], db.reviewed());
  expect(next.evidence.map((item) => item.text)).toEqual(['Edited after freeze', 'Late append']);
});
it('host pages exact oversized structured fields, preserving Unicode and offsets', () => {
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
  'makes no reviewer request for %s scope',
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
    const diagnostics = JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls);
    expect(diagnostics).not.toMatch(/SECRET|provider body|credential-command|contention/);
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
