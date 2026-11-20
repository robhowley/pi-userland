import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import {
  CAPTURE_MAX_ATTEMPTS,
  CAPTURE_RETRY_DELAY_MS,
  CaptureRetryableError,
  type CaptureWorkerOwnership,
} from '../extensions/remembrancer/capture-jobs.js';
import { importReadyHandoff, preserveHandoff } from '../extensions/remembrancer/capture-handoff.js';
import type { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import type { ProposalSubmission } from '../extensions/remembrancer/proposals.js';
import { runtime } from './fixtures/capture-job.js';

function submission(): ProposalSubmission {
  return {
    change: { operation: 'add', fields: { description: 'Send comparison' }, annotations: [] },
    expected: null,
    question: null,
    explanation: 'User promise',
    references: [
      {
        sessionId: 'session',
        branchId: 'promise',
        entryId: 'promise',
        editId: null,
        offset: 0,
        quote: 'Send Maya',
      },
    ],
  };
}

const dirs: string[] = [];
const stores: CheckpointStore[] = [];
const owners: CaptureWorkerOwnership[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.release();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function open(path: string) {
  const store = new CheckpointStore(path);
  stores.push(store);
  return store;
}
function close(store: CheckpointStore) {
  stores.splice(stores.indexOf(store), 1);
  store.close();
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
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'capture-limits-'));
  dirs.push(dir);
  const file = join(dir, 'source.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', id: 'session', cwd: dir }),
      JSON.stringify({
        type: 'message',
        id: 'promise',
        parentId: null,
        timestamp: '2026-01-20',
        message: { role: 'user', content: 'Send Maya the comparison' },
      }),
      '',
    ].join('\n'),
  );
  const path = join(dir, 'store.sqlite');
  const store = open(path);
  const owner = own(store);
  async function admit(id: string, sessionId = 'session') {
    const sourceFile = sessionId === 'session' ? file : join(dir, `${sessionId}.jsonl`);
    if (sourceFile !== file) {
      writeFileSync(
        sourceFile,
        readFileSync(file, 'utf8').replace('"id":"session"', `"id":"${sessionId}"`),
      );
    }
    const handoff = await preserveHandoff({
      id,
      inbox: join(dir, 'inbox'),
      source: { file: sourceFile, sessionId },
      execution: {
        cwd: dir,
        agentDir: dir,
        runtime,
        authorization: { autoCapture: true, disabled: false },
      },
    });
    await importReadyHandoff(store, owner, handoff.ready);
    return handoff;
  }
  const handoff = await admit('first');
  return { dir, file, path, store, owner, admit, handoff };
}
function child(path: string, action: string, id = 'first', value = 0) {
  return spawnSync(
    process.execPath,
    [
      '--loader',
      fileURLToPath(new URL('./fixtures/typescript-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/capture-jobs-child.mjs', import.meta.url)),
      path,
      id,
      `control-${action}`,
      String(value),
    ],
    { encoding: 'utf8', env: { NODE_NO_WARNINGS: '1' }, timeout: 8000 },
  );
}
function childOK(path: string, action: string, id = 'first', value = 0) {
  const result = child(path, action, id, value);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

it('commits count and identity before preparation, and rejects an unclaimed or copied identity', async () => {
  const f = await fixture();
  expect(f.store.captureJob('first')).toMatchObject({
    attemptCount: 0,
    revision: 1,
    activeAttemptId: null,
  });
  const unclaimed = f.owner.startAttempt('first');
  expect(Object.isFrozen(unclaimed)).toBe(true);
  expect(() => f.store.prepareCaptureJob(f.owner, unclaimed)).toThrow('durable capture attempt');
  f.owner.abandon(unclaimed);
  expect(child(f.path, 'claim').status).not.toBe(0);
  expect(f.store.captureJob('first')?.attemptCount).toBe(0);
  const attempt = f.store.claimCaptureAttempt(f.owner, 'first', 10)!;
  const peer = open(f.path);
  expect(peer.captureJob('first')).toMatchObject({
    attemptCount: 1,
    revision: 2,
    activeAttemptId: attempt.id,
  });
  expect(attempt.id).not.toBe(unclaimed.id);
  expect(() => f.store.assertCaptureAttempt(f.owner, { ...attempt })).toThrow(
    'active capture attempt',
  );
  expect(f.store.claimCaptureAttempt(f.owner, 'first', 10)).toBeUndefined();
  readAll(f.store.prepareCaptureJob(f.owner, attempt));
  f.store.finishCaptureJob(f.owner, attempt, []);
  expect(peer.captureJob('first')).toMatchObject({
    state: 'completed',
    attemptCount: 1,
    revision: 3,
    activeAttemptId: null,
  });
  expect(f.store.failCaptureJob(f.owner, attempt, 'late failure', true)).toBe(false);
});

it('does not admit after failed counter writes, commit faults, or initial manual contention', async () => {
  const f = await fixture();
  const sql = new DatabaseSync(f.path);
  try {
    sql.exec(`CREATE TRIGGER claim_fault BEFORE UPDATE OF attempt_count ON capture_jobs
      BEGIN SELECT RAISE(ABORT, 'claim write fault'); END`);
    expect(() => f.store.claimCaptureAttempt(f.owner, 'first')).toThrow('claim write fault');
    expect(f.store.captureJob('first')).toMatchObject({
      attemptCount: 0,
      revision: 1,
      activeAttemptId: null,
    });
    sql.exec('DROP TRIGGER claim_fault');
    // Deferred foreign-key failure happens at COMMIT, after the claim UPDATE.
    sql.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE claim_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE claim_child (id INTEGER REFERENCES claim_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER commit_fault AFTER UPDATE OF attempt_count ON capture_jobs
        BEGIN INSERT INTO claim_child VALUES (1); END`);
    // Foreign-key enforcement is per connection, so use a deferred violation on the store connection.
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => f.store.claimCaptureAttempt(f.owner, 'first')).toThrow('FOREIGN KEY');
    expect(f.store.captureJob('first')).toMatchObject({
      attemptCount: 0,
      revision: 1,
      activeAttemptId: null,
    });
    sql.exec('DROP TRIGGER commit_fault');
    const peer = open(f.path);
    peer.claimReview();
    expect(() => f.store.claimCaptureAttempt(f.owner, 'first')).toThrow(CaptureRetryableError);
    expect(f.store.captureJob('first')?.attemptCount).toBe(0);
    peer.releaseReview();
    const attempt = f.store.claimCaptureAttempt(f.owner, 'first')!;
    expect(() => f.store.assertCaptureAttempt(f.owner, attempt)).not.toThrow();
    expect(f.store.captureJob('first')?.attemptCount).toBe(1);
  } finally {
    sql.close();
  }
});

it('uses the same delay and allowance for selection, claim and post-release rechecks, then stops at two', async () => {
  const f = await fixture();
  const first = f.store.claimCaptureAttempt(f.owner, 'first', 100)!;
  expect(f.store.failCaptureJob(f.owner, first, 'Temporary provider failure', true, 100)).toBe(
    true,
  );
  const due = 100 + CAPTURE_RETRY_DELAY_MS;
  expect(f.store.captureJob('first')).toMatchObject({
    attemptCount: 1,
    nextAttemptAt: due,
    revision: 3,
    activeAttemptId: null,
  });
  expect(() => f.store.retryCaptureJob('first', 3)).toThrow('not stopped');
  for (const time of [100, due - 1]) {
    expect(f.store.runnableCaptureJobs(f.owner, time)).toEqual([]);
    expect(f.store.claimCaptureAttempt(f.owner, 'first', time)).toBeUndefined();
    expect(f.store.captureRecoveryPending(time)).toBe(false);
  }
  f.owner.release();
  expect(f.store.captureRecoveryPending(due)).toBe(true);
  const next = own(f.store);
  f.store.recoverInterruptedCaptureAttempts(next, due);
  const second = f.store.claimCaptureAttempt(next, 'first', due)!;
  expect(second.id).not.toBe(first.id);
  expect(f.store.captureJob('first')?.attemptCount).toBe(CAPTURE_MAX_ATTEMPTS);
  f.store.failCaptureJob(next, second, 'Temporary provider failure', true, due);
  const stopped = f.store.captureJob('first');
  expect(stopped).toMatchObject({
    state: 'failed',
    retryEligible: false,
    nextAttemptAt: null,
    attemptCount: 2,
    revision: 5,
    diagnostic: expect.stringContaining('exhausted'),
  });
  for (let wake = 0; wake < 3; wake++) {
    next.release();
    const owner = own(f.store);
    f.store.recoverInterruptedCaptureAttempts(owner, due + 100000);
    expect(f.store.runnableCaptureJobs(owner, due + 100000)).toEqual([]);
    expect(f.store.claimCaptureAttempt(owner, 'first', due + 100000)).toBeUndefined();
    owner.release();
    expect(f.store.captureRecoveryPending(due + 100000)).toBe(false);
  }
  expect(f.store.captureJob('first')).toEqual(stopped);
});

it('allows final-attempt preparation, frozen reads and publication without another admission', async () => {
  const f = await fixture();
  const first = f.store.claimCaptureAttempt(f.owner, 'first', 0)!;
  f.store.failCaptureJob(f.owner, first, 'Interrupted', true, 0);
  const final = f.store.claimCaptureAttempt(f.owner, 'first', CAPTURE_RETRY_DELAY_MS)!;
  expect(f.store.runnableCaptureJobs(f.owner, CAPTURE_RETRY_DELAY_MS)).toEqual([]);
  const review = f.store.prepareCaptureJob(f.owner, final);
  readAll(review);
  expect(() =>
    review.context({
      batch: review.id,
      selected: {
        sessionId: 'session',
        branchId: 'promise',
        entryId: 'promise',
        editId: null,
      },
    }),
  ).not.toThrow();
  expect(f.store.finishCaptureJob(f.owner, final, [submission()])).toHaveLength(1);
  expect(f.store.captureJob('first')).toMatchObject({
    state: 'completed',
    attemptCount: 2,
    revision: 5,
  });
  expect(f.store.reviewed()).toHaveLength(1);
  expect(() => f.store.retryCaptureJob('first', 5)).toThrow('not stopped');
});

it('types stale context and proposal publication races without partial publication', async () => {
  const f = await fixture();
  const attempt = f.store.claimCaptureAttempt(f.owner, 'first', 0)!;
  readAll(f.store.prepareCaptureJob(f.owner, attempt));
  expect(() =>
    f.store.finishCaptureJob(f.owner, attempt, [
      { ...submission(), id: 'missing-proposal', expectedRevision: 1 },
    ]),
  ).toThrow(CaptureRetryableError);
  expect(f.store.proposals()).toEqual([]);
  expect(f.store.reviewed()).toEqual([]);
  const peer = open(f.path);
  peer.claimReview();
  peer.releaseReview();
  expect(() => f.store.finishCaptureJob(f.owner, attempt, [])).toThrow(CaptureRetryableError);
  expect(f.store.captureJob('first')).toMatchObject({
    state: 'queued',
    activeAttemptId: attempt.id,
    attemptCount: 1,
    revision: 2,
  });
});

it('rolls pause and revocation back together on a failed write', async () => {
  const f = await fixture();
  const attempt = f.store.claimCaptureAttempt(f.owner, 'first', 0)!;
  const before = f.store.captureJob('first');
  const sql = new DatabaseSync(f.path);
  try {
    sql.exec(`CREATE TRIGGER pause_fault BEFORE UPDATE OF active_attempt_id ON capture_jobs
      BEGIN SELECT RAISE(ABORT, 'pause fault'); END`);
    expect(() => f.store.setCapturePaused(true, 10)).toThrow('pause fault');
    expect(f.store.captureStatus().paused).toBe(false);
    expect(f.store.captureJob('first')).toEqual(before);
    expect(() => f.store.assertCaptureAttempt(f.owner, attempt)).not.toThrow();
  } finally {
    sql.close();
  }
});

it('revokes frozen callbacks across process pause/resume, preserving count, evidence and unrelated stops', async () => {
  const f = await fixture();
  const unrelated = await f.admit('stopped', 'other');
  const stopped = f.store.claimCaptureAttempt(f.owner, 'stopped', 0)!;
  f.store.failCaptureJob(f.owner, stopped, 'Permanent configuration error', false, 0);
  const before = f.store.captureJob('stopped');
  const attempt = f.store.claimCaptureAttempt(f.owner, 'first', 0)!;
  const review = f.store.prepareCaptureJob(f.owner, attempt);
  readAll(review);
  const bytes = readFileSync(f.handoff.manifest.snapshot);
  childOK(f.path, 'pause', 'first', 10);
  expect(f.store.captureStatus().paused).toBe(true);
  expect(f.store.captureJob('first')).toMatchObject({
    attemptCount: 1,
    activeAttemptId: null,
    nextAttemptAt: 60010,
    revision: 3,
  });
  expect(f.store.captureJob('stopped')).toEqual(before);
  const revoked = f.store.captureJob('first');
  childOK(f.path, 'pause', 'first', 20);
  expect(f.store.captureJob('first')).toEqual(revoked);
  await f.admit('queued', 'queued-session');
  expect(f.store.runnableCaptureJobs(f.owner, 100000)).toEqual([]);
  expect(f.store.captureRecoveryPending(100000)).toBe(false);
  childOK(f.path, 'resume');
  expect(f.store.captureJob('first')).toEqual(revoked);
  expect(() => f.store.assertCaptureAttempt(f.owner, attempt)).toThrow('durable capture attempt');
  expect(() => review.page()).toThrow('durable capture attempt');
  expect(() => review.context({ batch: review.id })).toThrow('durable capture attempt');
  expect(() => f.store.finishCaptureJob(f.owner, attempt, [])).toThrow('durable capture attempt');
  expect(f.store.failCaptureJob(f.owner, attempt, 'stale failure', false, 30)).toBe(false);
  expect(f.store.captureJob('first')).toEqual(revoked);
  f.owner.abandon(attempt);
  expect(f.store.claimCaptureAttempt(f.owner, 'first', 60009)).toBeUndefined();
  const final = f.store.claimCaptureAttempt(f.owner, 'first', 60010)!;
  expect(final.id).not.toBe(attempt.id);
  childOK(f.path, 'pause', 'first', 60011);
  childOK(f.path, 'resume');
  expect(f.store.captureJob('first')).toMatchObject({
    attemptCount: 2,
    retryEligible: false,
    nextAttemptAt: null,
  });
  expect(f.store.captureJob('stopped')).toEqual(before);
  expect(readFileSync(f.handoff.manifest.snapshot)).toEqual(bytes);
  expect(existsSync(unrelated.manifest.snapshot)).toBe(true);
  expect(f.store.proposals()).toEqual([]);
  expect(f.store.reviewed()).toEqual([]);
});

it('explicit retry replaces allowance with revision CAS, never unpauses or bypasses a predecessor', async () => {
  const f = await fixture();
  const later = await f.admit('later');
  const other = await f.admit('other', 'other-session');
  const first = f.store.claimCaptureAttempt(f.owner, 'first', 0)!;
  f.store.failCaptureJob(f.owner, first, 'Invalid input', false, 0);
  const attempt = f.store.claimCaptureAttempt(f.owner, 'other', 0)!;
  f.store.failCaptureJob(f.owner, attempt, 'Unknown error', false, 0);
  const stopped = f.store.captureJob('other')!;
  f.store.setCapturePaused(true, 0);
  expect(f.store.captureStatus()).toMatchObject({
    paused: true,
    jobs: [
      { manifest: { id: 'first' }, blockedBy: null },
      { manifest: { id: 'later' }, blockedBy: 'first' },
      { manifest: { id: 'other' }, blockedBy: null },
    ],
  });
  expect(f.store.claimCaptureAttempt(f.owner, 'later', 100000)).toBeUndefined();
  expect(() => f.store.retryCaptureJob('missing', 1)).toThrow();
  expect(() => f.store.retryCaptureJob('other', stopped.revision - 1)).toThrow();
  const fresh = childOK(f.path, 'retry', 'other', stopped.revision);
  expect(fresh).toMatchObject({
    attemptCount: 0,
    nextAttemptAt: null,
    activeAttemptId: null,
    revision: stopped.revision + 1,
    diagnostic: null,
    state: 'queued',
  });
  expect(child(f.path, 'retry', 'other', stopped.revision).status).not.toBe(0);
  expect(() => f.store.retryCaptureJob('other', stopped.revision + 1)).toThrow();
  expect(f.store.captureStatus().paused).toBe(true);
  expect(f.store.captureRecoveryPending(100000)).toBe(false);
  f.store.setCapturePaused(false);
  expect(f.store.runnableCaptureJobs(f.owner, 100000).map((job) => job.manifest.id)).toEqual([
    'other',
  ]);
  const next = f.store.claimCaptureAttempt(f.owner, 'other', 100000)!;
  const readmitted = f.store.captureJob('other');
  expect(f.store.failCaptureJob(f.owner, attempt, 'Old callback after retry', true, 100000)).toBe(
    false,
  );
  expect(f.store.captureJob('other')).toEqual(readmitted);
  expect(() => f.store.retryCaptureJob('other', f.store.captureJob('other')!.revision)).toThrow();
  expect(f.store.captureJob('other')?.attemptCount).toBe(1);
  readAll(f.store.prepareCaptureJob(f.owner, next));
  f.store.finishCaptureJob(f.owner, next, []);
  expect(f.store.captureJob('later')?.manifest).toEqual(later.manifest);
  expect(f.store.captureJob('other')?.manifest).toEqual(other.manifest);
  expect(f.store.captureStatus().jobs.map((job) => job.manifest.id)).toEqual(['first', 'later']);
});

it('recovers cross-process committed claims without refunds and exhausts the same allowance', async () => {
  const f = await fixture();
  f.owner.release();
  const first = childOK(f.path, 'claim', 'first', 0);
  expect(first).toMatchObject({ jobId: 'first', id: expect.any(String) });
  expect(f.store.captureJob('first')).toMatchObject({ attemptCount: 1, revision: 2 });
  childOK(f.path, 'recover', 'first', 10);
  expect(f.store.captureJob('first')).toMatchObject({
    attemptCount: 1,
    revision: 3,
    activeAttemptId: null,
    nextAttemptAt: 60010,
  });
  expect(childOK(f.path, 'claim', 'first', 60009)).toBeNull();
  const second = childOK(f.path, 'claim', 'first', 60010);
  expect(second).not.toEqual(first);
  childOK(f.path, 'recover', 'first', 60011);
  expect(f.store.captureJob('first')).toMatchObject({
    attemptCount: 2,
    revision: 5,
    retryEligible: false,
    activeAttemptId: null,
    nextAttemptAt: null,
  });
  expect(childOK(f.path, 'claim', 'first', 1000000)).toBeNull();
  const stopped = f.store.captureJob('first');
  childOK(f.path, 'recover', 'first', 1000000);
  expect(f.store.captureJob('first')).toEqual(stopped);
  expect(existsSync(f.handoff.manifest.snapshot)).toBe(true);
});

it('rolls back an interrupted legacy migration atomically, then preserves evidence and migrates once', async () => {
  const f = await fixture();
  await f.admit('later');
  await f.admit('failed', 'failed-session');
  await f.admit('completed', 'completed-session');
  const attempt = f.store.claimCaptureAttempt(f.owner, 'completed')!;
  readAll(f.store.prepareCaptureJob(f.owner, attempt));
  f.store.finishCaptureJob(f.owner, attempt, []);
  f.owner.release();
  close(f.store);
  const sql = new DatabaseSync(f.path);
  try {
    sql.exec(`CREATE TABLE legacy_jobs AS SELECT id, session_id, snapshot, accepted_at,
      admission_order, body, state, retry_eligible, diagnostic FROM capture_jobs;
      DROP TABLE capture_jobs; ALTER TABLE legacy_jobs RENAME TO capture_jobs;
      DROP TABLE capture_control;
      UPDATE capture_jobs SET state = 'failed', retry_eligible = 0, diagnostic = 'Old diagnostic' WHERE id = 'failed';
      INSERT INTO proposals (id, revision, state, body) VALUES ('preserved', 7, 'pending', '{"evidence":"unchanged"}');
      PRAGMA user_version = 1;
      CREATE TRIGGER migration_fault BEFORE UPDATE ON capture_jobs WHEN NEW.id = 'failed'
        BEGIN SELECT RAISE(ABORT, 'migration fault'); END;`);
    const jobs = sql.prepare('SELECT * FROM capture_jobs ORDER BY rowid').all();
    const preserved = () =>
      ['proposals', 'sources', 'reviewed_boundaries', 'review_context'].map((table) =>
        sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const before = preserved();
    const schema = sql.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    const bytes = readFileSync(f.handoff.manifest.snapshot);
    expect(() => open(f.path)).toThrow('migration fault');
    expect(sql.prepare('PRAGMA user_version').get()!['user_version']).toBe(1);
    expect(sql.prepare('SELECT * FROM capture_jobs ORDER BY rowid').all()).toEqual(jobs);
    expect(sql.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
    expect(preserved()).toEqual(before);
    sql.exec('DROP TRIGGER migration_fault');
    const migrated = open(f.path);
    expect(sql.prepare('PRAGMA user_version').get()!['user_version']).toBe(2);
    expect(migrated.captureJob('first')).toMatchObject({
      state: 'failed',
      retryEligible: false,
      attemptCount: 0,
      activeAttemptId: null,
      nextAttemptAt: null,
      revision: 1,
      diagnostic: 'Historical attempts unknown; explicit retry required',
    });
    expect(migrated.captureJob('failed')?.diagnostic).toBe(
      'Old diagnostic; Historical attempts unknown; explicit retry required',
    );
    expect(migrated.captureJob('completed')).toMatchObject({
      state: 'completed',
      diagnostic: null,
      retryEligible: false,
    });
    expect(preserved()).toEqual(before);
    expect(sql.prepare('SELECT id, body FROM capture_jobs ORDER BY rowid').all()).toEqual(
      jobs.map((job) => ({ id: job['id'], body: job['body'] })),
    );
    expect(readFileSync(f.handoff.manifest.snapshot)).toEqual(bytes);
    const all = sql.prepare('SELECT * FROM capture_jobs ORDER BY rowid').all();
    close(migrated);
    const reopened = open(f.path);
    expect(sql.prepare('SELECT * FROM capture_jobs ORDER BY rowid').all()).toEqual(all);
    expect(preserved()).toEqual(before);
    const owner = own(reopened);
    expect(reopened.runnableCaptureJobs(owner)).toEqual([]);
    reopened.retryCaptureJob('later', 1);
    expect(reopened.claimCaptureAttempt(owner, 'later')).toBeUndefined();
    expect(
      reopened.captureStatus().jobs.find((job) => job.manifest.id === 'later')?.blockedBy,
    ).toBe('first');
    reopened.retryCaptureJob('first', 1);
    expect(reopened.claimCaptureAttempt(owner, 'first')).toBeDefined();
  } finally {
    sql.close();
  }
});
