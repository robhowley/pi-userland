import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  copyFileSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import * as notices from '../extensions/remembrancer/capture-notices.js';
import { captureJob, runtime } from './fixtures/capture-job.js';
import { CapturePreparationError } from '../extensions/remembrancer/capture-jobs.js';
import {
  cleanupCompletedSnapshot,
  importReadyHandoff,
  preserveHandoff,
  type HandoffInput,
} from '../extensions/remembrancer/capture-handoff.js';
import type { CaptureWorkerOwnership } from '../extensions/remembrancer/capture-jobs.js';
import type { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import type { ProposalSubmission } from '../extensions/remembrancer/proposals.js';
import {
  publishProposalNotice,
  readProposalNotice,
} from '../extensions/remembrancer/capture-notices.js';
import { runCaptureWorker } from '../extensions/remembrancer/capture-worker.js';

const dirs: string[] = [];
const stores: CheckpointStore[] = [];
const owners: CaptureWorkerOwnership[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  vi.useRealTimers();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  children.clear();
  for (const owner of owners.splice(0)) owner.release();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const record = (value: unknown) => JSON.stringify(value) + '\n';
const message = (id: string, parentId: string | null) =>
  record({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-20T00:00:00.000Z',
    message: { role: 'user', content: 'Send Maya the comparison' },
  });
async function fixture(id = 'first', entries = message('promise', null)) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-jobs-'));
  dirs.push(dir);
  const file = join(dir, 'source.jsonl');
  writeFileSync(file, record({ type: 'session', id: 'session', cwd: dir }) + entries);
  const input: HandoffInput = {
    id,
    inbox: join(dir, 'inbox'),
    source: { file, sessionId: 'session' },
    execution: {
      cwd: dir,
      agentDir: join(dir, 'agent'),
      runtime,
      authorization: { autoCapture: true, disabled: false },
    },
  };
  const handoff = await preserveHandoff(input);
  const path = join(dir, 'index.sqlite');
  const store = new CheckpointStore(path);
  stores.push(store);
  return { dir, path, input, handoff, store };
}
function own(store: CheckpointStore) {
  const owner = store.claimCaptureWorker();
  owners.push(owner);
  return owner;
}
function readAll(review: CaptureReview) {
  let page;
  do {
    page = review.page() as { hasMore: boolean };
  } while (page.hasMore);
}
function submission(
  editId: string | null = null,
  branchId = 'promise',
  sessionId = 'session',
): ProposalSubmission {
  return {
    change: { operation: 'add', fields: { description: 'Send comparison' }, annotations: [] },
    expected: null,
    question: null,
    explanation: 'User promise',
    references: [
      { sessionId, branchId, entryId: 'promise', editId, offset: 0, quote: 'Send Maya' },
    ],
  };
}
async function prepared() {
  const f = await fixture();
  const owner = own(f.store);
  await importReadyHandoff(f.store, owner, f.handoff.ready);
  const attempt = owner.startAttempt(f.input.id);
  const review = f.store.prepareCaptureJob(owner, attempt);
  readAll(review);
  return { ...f, owner, attempt, review };
}
function effects(store: CheckpointStore) {
  return {
    proposals: store.proposals(),
    sources: store.sources(),
    reviewed: store.reviewed(),
    context: store.contextGeneration(),
    notice: store.proposalNotice(),
  };
}

it('imports once, retains completed IDs, and safely repeats a post-commit manifest removal', async () => {
  const f = await fixture();
  const owner = own(f.store);
  const first = f.store.importCaptureJob(owner, f.handoff.manifest);
  expect(existsSync(f.handoff.ready)).toBe(true);
  expect(f.store.importCaptureJob(owner, f.handoff.manifest)).toEqual(first);
  await importReadyHandoff(f.store, owner, f.handoff.ready);
  expect(existsSync(f.handoff.ready)).toBe(false);
  const attempt = owner.startAttempt(f.input.id);
  readAll(f.store.prepareCaptureJob(owner, attempt));
  f.store.finishCaptureJob(owner, attempt, []);
  writeFileSync(f.handoff.ready, record(f.handoff.manifest));
  expect(await cleanupCompletedSnapshot(f.store, owner, f.input.id)).toBe(false);
  expect((await importReadyHandoff(f.store, owner, f.handoff.ready)).job.state).toBe('completed');
  expect(await cleanupCompletedSnapshot(f.store, owner, f.input.id)).toBe(true);
  writeFileSync(f.handoff.ready, record(f.handoff.manifest));
  expect((await importReadyHandoff(f.store, owner, f.handoff.ready)).job.state).toBe('completed');
  expect(f.store.runnableCaptureJobs(owner)).toEqual([]);
  expect(f.store.reviewed()).toHaveLength(1);
  expect(f.store.proposalNotice()).toEqual({ generation: 0, pending: 0 });
});

it('uses relocated enrollment for live coverage without restoring the accepted path', async () => {
  const f = await fixture(
    'first',
    message('promise', null) + message('left', 'promise') + message('right', 'promise'),
  );
  const owner = own(f.store);
  await importReadyHandoff(f.store, owner, f.handoff.ready);
  const relocated = join(f.dir, 'relocated.jsonl');
  copyFileSync(f.input.source.file, relocated);
  appendFileSync(relocated, message('covered-later', 'left'));
  f.store.enroll('session', relocated);
  f.store.finish([{ file: relocated, sessionId: 'session', entryId: 'covered-later' }]);
  rmSync(f.input.source.file);
  const attempt = owner.startAttempt('first');
  const review = f.store.prepareCaptureJob(owner, attempt);
  const page = review.page() as { groups: { branchId: string }[] };
  expect(page.groups.map((group) => group.branchId)).toEqual(['right']);
  const [saved] = f.store.finishCaptureJob(owner, attempt, [submission(null, 'right')]);
  expect(saved?.sources[0]).toMatchObject({ file: f.input.source.file, branchId: 'right' });
  expect(f.store.sources()[0]?.file).toBe(relocated);
});

it('keeps historical proposal references while enrollment moves during model work', async () => {
  const f = await prepared();
  const relocated = join(f.dir, 'relocated.jsonl');
  copyFileSync(f.input.source.file, relocated);
  const generation = f.store.contextGeneration();
  f.store.enroll('unrelated', '/unrelated.jsonl');
  f.store.enroll('unrelated', '/unrelated.jsonl');
  f.store.enroll('session', f.input.source.file);
  f.store.enroll('session', relocated);
  expect(f.store.contextGeneration()).toBe(generation);
  const [saved] = f.store.finishCaptureJob(f.owner, f.attempt, [submission()]);
  expect(saved?.sources[0]?.file).toBe(f.input.source.file);
  expect(f.store.sources().find((source) => source.sessionId === 'session')?.file).toBe(relocated);
});

it('imports physical inbox aliases without rewriting old manifest bodies', async () => {
  const f = await fixture();
  const alias = join(f.dir, 'inbox-alias');
  symlinkSync(f.input.inbox, alias);
  const owner = own(f.store);
  const legacySpelling = structuredClone(f.handoff.manifest);
  legacySpelling.snapshot = join(alias, 'first.snapshot.jsonl');
  f.store.importCaptureJob(owner, legacySpelling);
  const later = await preserveHandoff({ ...f.input, inbox: alias, id: 'later' });
  f.store.importCaptureJob(owner, later.manifest);
  expect(f.store.captureJob('first')?.manifest).toEqual(legacySpelling);
  expect(f.store.runnableCaptureJobs(owner).map((job) => job.manifest.id)).toEqual(['first']);
});

it('enumerates completed cleanup authority only for the current owner', async () => {
  const f = await prepared();
  expect(f.store.completedCaptureJobIds(f.owner)).toEqual([]);
  f.store.finishCaptureJob(f.owner, f.attempt, []);
  expect(f.store.completedCaptureJobIds(f.owner)).toEqual(['first']);
  f.owner.release();
  expect(() => f.store.completedCaptureJobIds(f.owner)).toThrow('ownership');
  const next = own(f.store);
  expect(f.store.completedCaptureJobIds(next)).toEqual(['first']);
});

it('persists classified immutable preparation failure and abandons its attempt once', async () => {
  const f = await fixture();
  const owner = own(f.store);
  await importReadyHandoff(f.store, owner, f.handoff.ready);
  writeFileSync(f.handoff.manifest.snapshot, '{bad retained JSON');
  const attempt = owner.startAttempt('first');
  const abandon = vi.spyOn(owner, 'abandon');
  let failure: unknown;
  try {
    f.store.prepareCaptureJob(owner, attempt);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CapturePreparationError);
  expect(failure).toMatchObject({ category: 'invalid-json', retryEligible: false });
  expect(abandon).toHaveBeenCalledExactlyOnceWith(attempt);
  const failed = f.store.captureJob('first');
  expect(failed).toMatchObject({
    state: 'failed',
    retryEligible: false,
    diagnostic: (failure as Error).message,
  });
  expect(() => f.store.failCaptureJob(owner, attempt, 'generic failure', true)).toThrow(
    'active capture attempt',
  );
  expect(f.store.captureJob('first')).toEqual(failed);
  expect(f.store.runnableCaptureJobs(owner)).toEqual([]);
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
});

it('retains the ready manifest and snapshot on an import transaction fault or missing snapshot', async () => {
  const f = await fixture();
  const owner = own(f.store);
  const sql = new DatabaseSync(f.path);
  sql.exec(
    "CREATE TRIGGER import_fault AFTER INSERT ON capture_jobs BEGIN SELECT RAISE(ABORT, 'import fault'); END",
  );
  await expect(importReadyHandoff(f.store, owner, f.handoff.ready)).rejects.toThrow('import fault');
  expect(f.store.captureJob('first')).toBeUndefined();
  expect(existsSync(f.handoff.ready)).toBe(true);
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
  sql.exec('DROP TRIGGER import_fault');
  sql.close();
  const bytes = await readFile(f.handoff.manifest.snapshot);
  await unlink(f.handoff.manifest.snapshot);
  await expect(importReadyHandoff(f.store, owner, f.handoff.ready)).rejects.toThrow();
  expect(f.store.captureJob('first')).toBeUndefined();
  expect(existsSync(f.handoff.ready)).toBe(true);
  writeFileSync(f.handoff.manifest.snapshot, bytes);
  expect((await importReadyHandoff(f.store, owner, f.handoff.ready)).job.state).toBe('queued');
});

it('rejects changed ID metadata and admission without authorization, without altering accepted evidence', async () => {
  const f = await fixture();
  const owner = own(f.store);
  f.store.importCaptureJob(owner, f.handoff.manifest);
  const bad = structuredClone(f.handoff.manifest);
  bad.execution.runtime.model.id = 'another-model';
  expect(() => f.store.importCaptureJob(owner, bad)).toThrow('metadata conflict');
  const unauthorized = structuredClone(f.input);
  unauthorized.execution.authorization.autoCapture = false as true;
  await expect(preserveHandoff({ ...unauthorized, id: 'unauthorized' })).rejects.toThrow(
    'validation: invalid-input',
  );
  expect(await readFile(f.handoff.manifest.snapshot, 'utf8')).toContain('Send Maya');
  expect(f.store.captureJob(f.input.id)?.manifest.execution.runtime.model.id).toBe('selected');
});

it.each([true, false])(
  'retains failures and explicit retry eligibility=%s, blocking newer edits in the same session',
  async (retryEligible) => {
    const f = await prepared();
    f.store.failCaptureJob(f.owner, f.attempt, 'Historical coverage unavailable', retryEligible);
    expect(f.store.captureJob(f.input.id)).toMatchObject({
      state: 'failed',
      retryEligible,
      diagnostic: 'Historical coverage unavailable',
    });
    expect(await cleanupCompletedSnapshot(f.store, f.owner, f.input.id)).toBe(false);
    appendFileSync(
      f.input.source.file,
      record({
        type: 'context_edit',
        id: 'edit',
        parentId: 'promise',
        targetId: 'promise',
        replacement: { content: 'Send Maya the comparison (edited)' },
      }),
    );
    const second = await preserveHandoff({ ...f.input, id: 'second' });
    f.store.importCaptureJob(f.owner, second.manifest);
    expect(f.store.runnableCaptureJobs(f.owner).map((job) => job.manifest.id)).toEqual(
      retryEligible ? ['first'] : [],
    );
    expect(readFileSync(f.handoff.manifest.snapshot, 'utf8')).not.toContain('edited');
    expect(readFileSync(second.manifest.snapshot, 'utf8')).toContain('edited');
    if (retryEligible) {
      const retry = f.owner.startAttempt('first');
      readAll(f.store.prepareCaptureJob(f.owner, retry));
      f.store.finishCaptureJob(f.owner, retry, []);
      const next = f.owner.startAttempt('second');
      const review = f.store.prepareCaptureJob(f.owner, next);
      readAll(review);
      const saved = f.store.finishCaptureJob(f.owner, next, [submission('edit', 'edit')]);
      expect(saved[0]?.sources[0]).toMatchObject({ editId: 'edit', file: f.input.source.file });
      expect(f.store.captureJob('first')?.state).toBe('completed');
    }
  },
);

it.each([
  ['clock advances', '2026-01-03T00:00:00.000Z'],
  ['same millisecond', '2026-01-02T00:00:00.000Z'],
  ['clock rolls backward', '2026-01-01T00:00:00.000Z'],
])(
  'preserves FIFO when %s, including selection between reverse imports',
  async (_timing, laterTime) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-01-02T00:00:00.000Z');
    const f = await fixture();
    const owner = own(f.store);
    vi.setSystemTime(laterTime!);
    const later = await preserveHandoff({ ...f.input, id: 'later' });
    expect(later.manifest.acceptedAt).toBe(laterTime);
    expect(later.manifest.admissionOrder > f.handoff.manifest.admissionOrder).toBe(true);
    await importReadyHandoff(f.store, owner, later.ready);
    expect(f.store.runnableCaptureJobs(owner)).toEqual([]);
    await importReadyHandoff(f.store, owner, f.handoff.ready);
    expect(f.store.runnableCaptureJobs(owner).map((job) => job.manifest.id)).toEqual(['first']);
    const attempt = owner.startAttempt('first');
    readAll(f.store.prepareCaptureJob(owner, attempt));
    f.store.finishCaptureJob(owner, attempt, []);
    expect(f.store.runnableCaptureJobs(owner).map((job) => job.manifest.id)).toEqual(['later']);
  },
);

it('rejects incomparable inboxes and duplicate publication sequences without replacing accepted evidence', async () => {
  const f = await fixture();
  const owner = own(f.store);
  f.store.importCaptureJob(owner, f.handoff.manifest);
  const later = await preserveHandoff({ ...f.input, id: 'later' });
  const duplicate = { ...later.manifest, admissionOrder: f.handoff.manifest.admissionOrder };
  expect(() => f.store.importCaptureJob(owner, duplicate)).toThrow(
    'Conflicting capture publication order',
  );
  expect(f.store.captureJob('later')).toBeUndefined();
  const other = await fixture('other-inbox');
  expect(() => f.store.importCaptureJob(owner, other.handoff.manifest)).toThrow(
    'one inbox per database',
  );
  expect(existsSync(other.handoff.ready)).toBe(true);
  expect(f.store.importCaptureJob(owner, later.manifest).state).toBe('queued');
  expect(f.store.captureJob('first')?.manifest).toEqual(f.handoff.manifest);
});

it('holds no manual lock during frozen pages/context and rejects manual begin then cancel, even for empty output', async () => {
  const f = await prepared();
  const peer = new CheckpointStore(f.path);
  stores.push(peer);
  const before = effects(f.store);
  peer.claimReview();
  peer.releaseReview();
  expect(() => f.review.page()).not.toThrow();
  expect(() => f.store.finishCaptureJob(f.owner, f.attempt, [])).toThrow('context changed');
  expect(f.store.reviewed()).toEqual(before.reviewed);
  expect(f.store.captureJob('first')?.state).toBe('queued');
  expect(f.store.proposalNotice()).toEqual(before.notice);
});

it.each([
  'coverage',
  'default',
  'edit',
  'dismiss',
  'application claim',
  'application outcome',
] as const)('rejects stale new-ID and empty submissions after %s', async (mutation) => {
  const f = await prepared();
  // Seed through another durable job before freezing the attempt under test.
  f.owner.abandon(f.attempt);
  const other = join(f.dir, 'other.jsonl');
  writeFileSync(
    other,
    record({ type: 'session', id: 'seed', cwd: f.dir }) + message('promise', null),
  );
  const seed = captureJob(f.store, { sessionId: 'seed', file: other }, f.owner);
  readAll(seed.review);
  const existing = f.store.finishCaptureJob(f.owner, seed.attempt, [
    submission(null, 'promise', 'seed'),
  ])[0]!;
  const applying =
    mutation === 'application outcome'
      ? f.store.claimProposal(existing.id, existing.revision, null)
      : undefined;
  const attempt = f.owner.startAttempt('first');
  const review = f.store.prepareCaptureJob(f.owner, attempt);
  readAll(review);
  // Eligible evidence remains. Even new-ID and empty results must validate
  // the frozen context, not just revisions of explicitly named proposals.
  expect(review.hasEvidence).toBe(true);
  const generation = f.store.contextGeneration();
  if (mutation === 'coverage')
    f.store.finish({
      checkpoints: [{ sessionId: 'seed', file: other, entryId: 'promise', since: null }],
    });
  if (mutation === 'default')
    f.store.finish({ sourceDefaults: [{ sessionId: 'seed', since: '2025-01-01' }] });
  if (mutation === 'edit')
    f.store.editProposal(existing.id, existing.revision, {
      change: existing.change,
      expected: existing.expected,
      question: 'Clarify',
    });
  if (mutation === 'dismiss') f.store.dismissProposal(existing.id, existing.revision);
  if (mutation === 'application claim') f.store.claimProposal(existing.id, existing.revision, null);
  if (applying)
    f.store.recordProposalResult(applying.id, applying.revision, applying.claim!, {
      state: 'uncertain',
      verified: null,
      error: 'write uncertain',
    });
  expect(f.store.contextGeneration()).toBeGreaterThan(generation);
  const before = effects(f.store);
  for (const output of [[], [submission()]])
    expect(() => f.store.finishCaptureJob(f.owner, attempt, output)).toThrow('context changed');
  expect(effects(f.store)).toEqual(before);
  expect(f.store.captureJob('first')?.state).toBe('queued');
});

it('defers to long-held manual ownership and requires a new attempt after the context changes', async () => {
  const f = await prepared();
  const peer = new CheckpointStore(f.path);
  stores.push(peer);
  peer.claimReview();
  expect(() => f.store.finishCaptureJob(f.owner, f.attempt, [])).toThrow('already open');
  expect(f.store.captureJob('first')?.state).toBe('queued');
  peer.releaseReview();
  expect(() => f.store.finishCaptureJob(f.owner, f.attempt, [])).toThrow('context changed');
  f.store.failCaptureJob(f.owner, f.attempt, 'Context conflict; reprepare', true);
  const retry = f.owner.startAttempt('first');
  readAll(f.store.prepareCaptureJob(f.owner, retry));
  f.store.finishCaptureJob(f.owner, retry, []);
  expect(f.store.captureJob('first')?.state).toBe('completed');
});

it('commits saved references, coverage, completion and notice together', async () => {
  const f = await prepared();
  const saved = f.store.finishCaptureJob(f.owner, f.attempt, [submission()]);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.sources[0]).toMatchObject({
    file: f.input.source.file,
    sessionId: 'session',
    entryId: 'promise',
    editId: null,
    branchId: 'promise',
    quote: 'Send Maya',
    role: 'user',
    locator: 'session/promise/promise',
    offset: 0,
  });
  expect(f.store.reviewed()).toHaveLength(1);
  expect(f.store.captureJob('first')?.state).toBe('completed');
  expect(f.store.proposalNotice()).toEqual({ generation: 1, pending: 1 });
  const notice = f.store.proposalNotice();
  f.store.editProposal(saved[0]!.id, 1, {
    change: saved[0]!.change,
    expected: null,
    question: 'Clarify',
  });
  expect(f.store.proposalNotice()).toEqual({ generation: notice.generation + 1, pending: 1 });
  expect(() => f.review.page()).toThrow('active capture attempt');
});

it.each(['proposal', 'coverage source', 'coverage boundary', 'completion', 'notice'] as const)(
  'rolls back every durable effect on a transaction fault at %s',
  async (fault) => {
    const f = await prepared();
    const sql = new DatabaseSync(f.path);
    const trigger = {
      proposal: 'BEFORE INSERT ON proposals',
      'coverage source': 'BEFORE INSERT ON sources',
      'coverage boundary': 'BEFORE INSERT ON reviewed_boundaries',
      completion: "BEFORE UPDATE ON capture_jobs WHEN NEW.state = 'completed'",
      notice: 'BEFORE UPDATE ON review_context WHEN NEW.notice_generation > OLD.notice_generation',
    }[fault];
    sql.exec(
      `CREATE TRIGGER injected_fault ${trigger} BEGIN SELECT RAISE(ABORT, 'injected transaction fault'); END`,
    );
    const before = effects(f.store);
    expect(() => f.store.finishCaptureJob(f.owner, f.attempt, [submission()])).toThrow(
      'injected transaction fault',
    );
    expect(effects(f.store)).toEqual(before);
    expect(f.store.captureJob('first')?.state).toBe('queued');
    expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
    sql.exec('DROP TRIGGER injected_fault');
    sql.close();
    expect(f.store.finishCaptureJob(f.owner, f.attempt, [submission()])).toHaveLength(1);
  },
);

it.each(['already-covered', 'no-evidence'] as const)(
  'completes %s without manufacturing coverage or notices',
  async (kind) => {
    const f = await fixture();
    const owner = own(f.store);
    if (kind === 'no-evidence') {
      // Create an empty saved tree using a different handoff, not by mutating an
      // accepted snapshot. The first retained boundary remains independently queued.
      await importReadyHandoff(f.store, owner, f.handoff.ready);
      writeFileSync(f.input.source.file, record({ type: 'session', id: 'empty', cwd: f.dir }));
      const empty = await preserveHandoff({
        ...f.input,
        id: 'empty',
        source: { ...f.input.source, sessionId: 'empty' },
      });
      f.store.importCaptureJob(owner, empty.manifest);
    } else {
      f.store.enroll('session', f.input.source.file);
      f.store.finish([{ file: f.input.source.file, sessionId: 'session', entryId: 'promise' }]);
      f.store.importCaptureJob(owner, f.handoff.manifest);
    }
    const before = effects(f.store);
    const id = kind === 'no-evidence' ? 'empty' : 'first';
    const attempt = owner.startAttempt(id);
    const review = f.store.prepareCaptureJob(owner, attempt);
    expect(review.hasEvidence).toBe(false);
    f.store.finishCaptureJob(owner, attempt, []);
    expect(effects(f.store)).toEqual(before);
    expect(f.store.captureJob(id)?.state).toBe('completed');
  },
);

it('fails closed with retained evidence/diagnostic when historical coverage cannot be mapped', async () => {
  const f = await fixture();
  const owner = own(f.store);
  await importReadyHandoff(f.store, owner, f.handoff.ready);
  f.store.enroll('session', f.input.source.file);
  f.store.finish([{ file: f.input.source.file, sessionId: 'session', entryId: 'absent' }]);
  const before = effects(f.store);
  const attempt = owner.startAttempt('first');
  expect(() => f.store.prepareCaptureJob(owner, attempt)).toThrow('checkpoint unavailable');
  expect(f.store.captureJob('first')).toMatchObject({
    state: 'failed',
    retryEligible: true,
    diagnostic: expect.stringContaining('checkpoint unavailable'),
  });
  expect(effects(f.store)).toEqual(before);
  expect(await cleanupCompletedSnapshot(f.store, owner, 'first')).toBe(false);
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
});

it('invalidates abandoned identities and release/reacquire callbacks permanently', async () => {
  const f = await prepared();
  expect(() => f.store.prepareCaptureJob(f.owner, f.attempt)).toThrow('already has a frozen');
  f.owner.abandon(f.attempt);
  const retry = f.owner.startAttempt('first');
  const review = f.store.prepareCaptureJob(f.owner, retry);
  readAll(review);
  expect(() => f.review.page()).toThrow('active capture attempt');
  expect(() => f.store.finishCaptureJob(f.owner, f.attempt, [])).toThrow('active capture attempt');
  f.owner.release();
  const next = own(f.store);
  const nextAttempt = next.startAttempt('first');
  readAll(f.store.prepareCaptureJob(next, nextAttempt));
  f.owner.release(); // A late old release must not close the new owner's lock.
  expect(() => review.page()).toThrow();
  expect(() => f.store.finishCaptureJob(f.owner, retry, [])).toThrow('ownership');
  expect(() => f.store.claimCaptureWorker()).toThrow('already owns');
  f.store.finishCaptureJob(next, nextAttempt, []);
});

it('protects exact admission metadata in the final transaction', async () => {
  const f = await prepared();
  const before = effects(f.store);
  const sql = new DatabaseSync(f.path);
  try {
    const changed = structuredClone(f.handoff.manifest);
    changed.execution.authorization.autoCapture = false as true;
    sql
      .prepare('UPDATE capture_jobs SET body = ? WHERE id = ?')
      .run(JSON.stringify(changed), f.input.id);
    for (const output of [[], [submission()]]) {
      expect(() => f.store.finishCaptureJob(f.owner, f.attempt, output)).toThrow(
        'durable capture job',
      );
      expect(effects(f.store)).toEqual(before);
      expect(f.store.captureJob(f.input.id)?.state).toBe('queued');
    }
    sql
      .prepare('UPDATE capture_jobs SET body = ? WHERE id = ?')
      .run(JSON.stringify(f.handoff.manifest), f.input.id);
  } finally {
    sql.close();
  }
  expect(f.store.finishCaptureJob(f.owner, f.attempt, [submission()])).toHaveLength(1);
});

it('conservatively retains completed snapshots through ambiguous manifests and cleanup failures', async () => {
  const f = await prepared();
  f.store.finishCaptureJob(f.owner, f.attempt, []);
  const ambiguous = join(f.input.inbox, 'ambiguous.ready.json');
  writeFileSync(ambiguous, '{broken');
  await expect(cleanupCompletedSnapshot(f.store, f.owner, 'first')).rejects.toThrow();
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
  await unlink(ambiguous);
  // A filesystem failure at unlink must leave the completed row intact and must
  // not touch other retained artifacts. A directory at this path forces EISDIR.
  const bytes = await readFile(f.handoff.manifest.snapshot);
  await unlink(f.handoff.manifest.snapshot);
  mkdirSync(f.handoff.manifest.snapshot);
  await expect(cleanupCompletedSnapshot(f.store, f.owner, 'first')).rejects.toThrow();
  expect(f.store.captureJob('first')?.state).toBe('completed');
  rmSync(f.handoff.manifest.snapshot, { recursive: true });
  writeFileSync(f.handoff.manifest.snapshot, bytes);
  expect(await cleanupCompletedSnapshot(f.store, f.owner, 'first')).toBe(true);
});

it('checks all unresolved SQLite snapshot references before completed cleanup', async () => {
  const f = await prepared();
  f.store.finishCaptureJob(f.owner, f.attempt, []);
  const other = await preserveHandoff({ ...f.input, id: 'other' });
  f.store.importCaptureJob(f.owner, other.manifest);
  const sql = new DatabaseSync(f.path);
  sql
    .prepare('UPDATE capture_jobs SET snapshot = ? WHERE id = ?')
    .run(f.handoff.manifest.snapshot, 'other');
  expect(await cleanupCompletedSnapshot(f.store, f.owner, 'first')).toBe(false);
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
  sql
    .prepare('UPDATE capture_jobs SET snapshot = ? WHERE id = ?')
    .run(other.manifest.snapshot, 'other');
  sql.close();
  expect(await cleanupCompletedSnapshot(f.store, f.owner, 'first')).toBe(true);
  expect(existsSync(other.manifest.snapshot)).toBe(true);
});

function publishInChild(input: HandoffInput, acceptedAt = '2020-01-01T00:00:00.000Z') {
  return spawnSync(
    process.execPath,
    [
      '--loader',
      fileURLToPath(new URL('./fixtures/typescript-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/capture-publication-child.mjs', import.meta.url)),
      JSON.stringify(input),
      acceptedAt,
    ],
    { encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 8000 },
  );
}

it('preserves publication FIFO across processes and clock rollback, independent of reverse import', async () => {
  const f = await fixture();
  const owner = own(f.store);
  const child = publishInChild({ ...f.input, id: 'child' });
  expect(child.status, child.stderr).toBe(0);
  const ready = join(f.input.inbox, 'child.ready.json');
  const later = (await importReadyHandoff(f.store, owner, ready)).job.manifest;
  expect(later.acceptedAt < f.handoff.manifest.acceptedAt).toBe(true);
  expect(later.admissionOrder > f.handoff.manifest.admissionOrder).toBe(true);
  expect(f.store.runnableCaptureJobs(owner)).toEqual([]);
  await importReadyHandoff(f.store, owner, f.handoff.ready);
  expect(f.store.runnableCaptureJobs(owner).map((job) => job.manifest.id)).toEqual(['first']);
  const attempt = owner.startAttempt('first');
  f.store.failCaptureJob(owner, attempt, 'Retained failure', false);
  expect(f.store.runnableCaptureJobs(owner)).toEqual([]);
  expect(existsSync(later.snapshot)).toBe(true);
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
});

it('completes a frozen attempt once when a later unimported ready file appears', async () => {
  const f = await prepared();
  appendFileSync(f.input.source.file, message('later', 'promise'));
  const later = await preserveHandoff({ ...f.input, id: 'later' });
  expect(f.store.runnableCaptureJobs(f.owner)).toEqual([]);
  expect(f.store.finishCaptureJob(f.owner, f.attempt, [submission()])).toHaveLength(1);
  expect(() => f.store.finishCaptureJob(f.owner, f.attempt, [submission()])).toThrow(
    'active capture attempt',
  );
  expect(f.store.proposals()).toHaveLength(1);
  await importReadyHandoff(f.store, f.owner, later.ready);
  const next = f.owner.startAttempt('later');
  const review = f.store.prepareCaptureJob(f.owner, next);
  readAll(review);
  f.store.finishCaptureJob(f.owner, next, []);
  expect(f.store.captureJob('later')?.state).toBe('completed');
});

it('rejects completion if an actual earlier job is unresolved, without relying on the ready barrier', async () => {
  const f = await prepared();
  f.store.finishCaptureJob(f.owner, f.attempt, []);
  appendFileSync(f.input.source.file, message('later', 'promise'));
  const later = await preserveHandoff({ ...f.input, id: 'later' });
  await importReadyHandoff(f.store, f.owner, later.ready);
  const attempt = f.owner.startAttempt('later');
  readAll(f.store.prepareCaptureJob(f.owner, attempt));
  const sql = new DatabaseSync(f.path);
  sql.exec(
    "UPDATE capture_jobs SET state = 'failed', retry_eligible = 0, diagnostic = 'unresolved predecessor' WHERE id = 'first'",
  );
  sql.close();
  const before = effects(f.store);
  expect(() => f.store.finishCaptureJob(f.owner, attempt, [])).toThrow('durable capture job');
  expect(effects(f.store)).toEqual(before);
  expect(f.store.captureJob('later')?.state).toBe('queued');
});

it.each([1, 2, 99, null])(
  'retains stored unsupported version %s and blocks its session without migration',
  async (version) => {
    const f = await fixture();
    const owner = own(f.store);
    await importReadyHandoff(f.store, owner, f.handoff.ready);
    const sql = new DatabaseSync(f.path);
    sql
      .prepare(
        "UPDATE capture_jobs SET body = json_set(body, '$.version', ?), admission_order = ? WHERE id = ?",
      )
      .run(version, '9'.repeat(32), 'first');
    sql.close();
    const later = await preserveHandoff({ ...f.input, id: 'later' });
    f.store.importCaptureJob(owner, later.manifest);
    expect(f.store.runnableCaptureJobs(owner)).toEqual([]);
    const blocked = owner.startAttempt('first');
    expect(() => f.store.prepareCaptureJob(owner, blocked)).toThrow('not runnable');
    owner.abandon(blocked);
    const other = await preserveHandoff({
      ...f.input,
      id: 'other',
      source: { ...f.input.source, sessionId: 'other' },
    });
    f.store.importCaptureJob(owner, other.manifest);
    expect(f.store.runnableCaptureJobs(owner).map((job) => job.manifest.id)).toEqual(['other']);
    expect(f.store.captureJob('first')?.state).toBe('queued');
    expect(await cleanupCompletedSnapshot(f.store, owner, 'first')).toBe(false);
  },
);

function probe(path: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); try { db.exec('BEGIN IMMEDIATE'); console.log('owned'); } catch(e) { if(e.errcode !== 5) throw e; console.log('busy'); } finally { db.close(); }`,
      path + '.worker-lock',
    ],
    { encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' } },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
it('preserves worker descriptor lifetime through failed claims and unrelated store/review open-close operations', async () => {
  const f = await prepared();
  expect(probe(f.path)).toBe('busy');
  for (let index = 0; index < 3; index++) {
    const peer = new CheckpointStore(f.path);
    expect(() => peer.claimCaptureWorker()).toThrow('already owns');
    peer.claimReview();
    peer.releaseReview();
    peer.close();
    expect(probe(f.path)).toBe('busy');
  }
  f.owner.release();
  expect(probe(f.path)).toBe('owned');
});

async function stoppedChild(f: Awaited<ReturnType<typeof fixture>>, point: string) {
  const home = join(f.dir, 'home');
  for (const name of ['config', 'data', 'state', 'cache', 'agent', 'tasks', 'tmp'])
    mkdirSync(join(home, name), { recursive: true });
  writeFileSync(join(home, 'agent', 'settings.json'), '{}');
  writeFileSync(join(home, 'taskrc'), '');
  const marker = join(f.dir, 'stopped');
  const child = spawn(
    process.execPath,
    [
      '--loader',
      fileURLToPath(new URL('./fixtures/typescript-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/capture-jobs-child.mjs', import.meta.url)),
      f.path,
      f.handoff.ready,
      point,
      marker,
    ],
    {
      cwd: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        XDG_CACHE_HOME: join(home, 'cache'),
        PI_CODING_AGENT_DIR: join(home, 'agent'),
        TASKRC: join(home, 'taskrc'),
        TASKDATA: join(home, 'tasks'),
        TMPDIR: join(home, 'tmp'),
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 8000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
      throw Error(`Child failed at ${point}: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  children.delete(child);
}

it('surfaces an early child failure without waiting forever in teardown', async () => {
  const f = await fixture();
  await expect(stoppedChild(f, 'invalid-boundary')).rejects.toThrow(
    'Unreached crash boundary: invalid-boundary',
  );
});

it('delays notices across commit-before-replacement SIGKILL, then repairs from SQLite on recovery', async () => {
  const f = await fixture();
  await publishProposalNotice(f.store);
  expect(await readProposalNotice(f.path)).toEqual({ generation: 0, pending: 0 });
  await stoppedChild(f, 'completion-commit');
  expect(f.store.proposalNotice()).toEqual({ generation: 1, pending: 1 });
  expect(await readProposalNotice(f.path)).toEqual({ generation: 0, pending: 0 });
  // Completed job, no runtime/model needed: startup repair alone recovers delivery.
  await runCaptureWorker({ database: f.path, inbox: f.input.inbox });
  expect(await readProposalNotice(f.path)).toEqual({ generation: 1, pending: 1 });
  expect(f.store.proposals()).toHaveLength(1);
});

it('repairs same-count proposal edits after a failed notice-publication wake without review', async () => {
  const f = await prepared();
  const [proposal] = f.store.finishCaptureJob(f.owner, f.attempt, [submission()]);
  await publishProposalNotice(f.store);
  f.owner.release();
  f.store.editProposal(proposal!.id, proposal!.revision, {
    change: proposal!.change,
    expected: proposal!.expected,
    question: 'Updated question',
  });
  expect(f.store.proposalNotice()).toEqual({ generation: 2, pending: 1 });
  expect(await readProposalNotice(f.path)).toEqual({ generation: 1, pending: 1 });
  const review = vi.fn().mockRejectedValue(Error('Unexpected review'));
  const notice = vi
    .spyOn(notices, 'publishProposalNotice')
    .mockRejectedValue(
      Object.assign(Error('credential-provider-body-command'), { code: 'ENOSPC' }),
    );
  try {
    await runCaptureWorker({ database: f.path, inbox: f.input.inbox, review });
    expect(notice).toHaveBeenCalled();
    expect(await readProposalNotice(f.path)).toEqual({ generation: 1, pending: 1 });
    expect(f.store.proposalNotice()).toEqual({ generation: 2, pending: 1 });
  } finally {
    notice.mockRestore();
  }
  const log = readFileSync(f.path + '.capture.log', 'utf8');
  expect(log).toContain('notice-publication');
  expect(log).toContain('ENOSPC');
  expect(log).not.toContain('credential-provider-body-command');
  expect(log).not.toContain('contention');
  await runCaptureWorker({ database: f.path, inbox: f.input.inbox, review });
  expect(review).not.toHaveBeenCalled();
  expect(await readProposalNotice(f.path)).toEqual({ generation: 2, pending: 1 });
});

it('repairs a committed change arriving during startup replacement before clean worker exit', async () => {
  const f = await prepared();
  const [proposal] = f.store.finishCaptureJob(f.owner, f.attempt, [submission()]);
  f.owner.release();
  const read = CheckpointStore.prototype.proposalNotice;
  let changed = false;
  vi.spyOn(CheckpointStore.prototype, 'proposalNotice').mockImplementation(function (
    this: CheckpointStore,
  ) {
    const snapshot = read.call(this);
    if (!changed) {
      changed = true;
      f.store.editProposal(proposal!.id, proposal!.revision, {
        change: proposal!.change,
        expected: null,
        question: 'Changed during sidecar write',
      });
    }
    return snapshot;
  });
  try {
    await runCaptureWorker({
      database: f.path,
      inbox: f.input.inbox,
      afterRelease: async () => {
        expect(await readProposalNotice(f.path)).toEqual({ generation: 2, pending: 1 });
      },
    });
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([
  'import-insert',
  'import-commit',
  'manifest-removed',
  'prepared',
  'proposal',
  'coverage',
  'job-completed',
  'completion-commit',
  'cleanup',
])(
  'recovers after real SIGKILL at %s with all-or-nothing effects and retained unresolved evidence',
  async (point) => {
    const f = await fixture();
    await stoppedChild(f, point);
    const committed = ['completion-commit', 'cleanup'].includes(point);
    expect(f.store.proposals()).toHaveLength(committed ? 1 : 0);
    expect(f.store.reviewed()).toHaveLength(committed ? 1 : 0);
    expect(f.store.captureJob('first')?.state).toBe(
      point === 'import-insert' ? undefined : committed ? 'completed' : 'queued',
    );
    expect(f.store.proposalNotice()).toEqual({
      generation: committed ? 1 : 0,
      pending: committed ? 1 : 0,
    });
    expect(existsSync(f.handoff.manifest.snapshot)).toBe(point !== 'cleanup');
    const owner = own(f.store);
    if (existsSync(f.handoff.ready)) await importReadyHandoff(f.store, owner, f.handoff.ready);
    if (!committed) {
      const attempt = owner.startAttempt('first');
      readAll(f.store.prepareCaptureJob(owner, attempt));
      f.store.finishCaptureJob(owner, attempt, [submission()]);
    }
    expect(f.store.proposals()).toHaveLength(1);
  },
  12000,
);
