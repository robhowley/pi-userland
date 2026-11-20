import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { openPrivateSqlite } from './private-sqlite.mjs';
import { CaptureReview } from './capture-review.js';
import {
  CAPTURE_MAX_ATTEMPTS,
  CAPTURE_RETRY_DELAY_MS,
  CapturePreparationError,
  CaptureRetryableError,
  CaptureWorkerOwnership,
  type CaptureAttempt,
  type CaptureJob,
  type CaptureStatus,
} from './capture-jobs.js';
import { physicalInbox, validateReadyManifest, type ReadyManifest } from './capture-handoff.js';
import { prepareHistoricalReview } from './evidence.js';
import {
  validateDraft,
  validateSnapshot,
  unionProposalSources,
  type Proposal,
  type ProposalDraft,
  type ProposalSubmission,
  type ProposalState,
  type ApplicationResult,
  type TaskSnapshot,
} from './proposals.js';
import type { Checkpoint, SeedDefault, Source, Tip } from './evidence.js';

export type StoredSource = Omit<Source, 'seedSince'> & { seedSince: string | null };

export type FinishPlan = {
  sources?: readonly Source[];
  sourceDefaults?: readonly SeedDefault[];
  checkpoints?: readonly (Tip | Checkpoint)[];
};

export function defaultCheckpointFile(): string {
  const state = process.env['XDG_STATE_HOME'];
  return join(
    state && isAbsolute(state) ? state : join(homedir(), '.local', 'state'),
    'pi-remembrancer',
    'checkpoints.sqlite3',
  );
}

function openPrivate(filename: string): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  return openPrivateSqlite(filename);
}

function absoluteTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid checkpoint timestamp: ${value}`);
  return new Date(milliseconds).toISOString();
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[]).some(
    (item) => item.name === column,
  );
}

function checkpointFromTip(tip: Tip): Checkpoint {
  const candidate = tip as Tip & { since?: string | null };
  return { ...tip, since: candidate.since ?? null };
}

// Unsupported rows fence their session even when their order cannot be interpreted.
const predecessor = `SELECT earlier.id FROM capture_jobs AS earlier
  WHERE earlier.id <> job.id AND earlier.session_id = job.session_id
  AND earlier.state <> 'completed'
  AND (json_extract(earlier.body, '$.version') IS NOT 3
    OR earlier.admission_order < job.admission_order)
  ORDER BY earlier.admission_order LIMIT 1`;

export class CheckpointStore {
  private db: DatabaseSync;
  private filename: string;
  private reviewLock: DatabaseSync | undefined;
  private jobCapture:
    | {
        owner: CaptureWorkerOwnership;
        attempt: CaptureAttempt;
        review: CaptureReview;
        generation: number;
        body: string;
      }
    | undefined;

  get file(): string {
    return this.filename;
  }

  constructor(filename = defaultCheckpointFile()) {
    this.filename = filename;
    this.db = openPrivate(filename);
    if (filename !== ':memory:') this.filename = realpathSync(filename);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          session_id TEXT PRIMARY KEY,
          session_file TEXT NOT NULL,
          seed_since TEXT
        );
        CREATE TABLE IF NOT EXISTS reviewed_boundaries (
          session_id TEXT NOT NULL REFERENCES sources(session_id),
          tip_id TEXT NOT NULL CHECK(tip_id <> ''),
          since TEXT,
          PRIMARY KEY (session_id, tip_id)
        )`);
      if (!tableHasColumn(this.db, 'sources', 'seed_since'))
        this.db.exec('ALTER TABLE sources ADD COLUMN seed_since TEXT');
      if (!tableHasColumn(this.db, 'reviewed_boundaries', 'since'))
        this.db.exec('ALTER TABLE reviewed_boundaries ADD COLUMN since TEXT');
      this.db.exec(`CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL,
        body TEXT NOT NULL
      )`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS review_context (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          generation INTEGER NOT NULL, notice_generation INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO review_context VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS capture_jobs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot TEXT NOT NULL,
          accepted_at TEXT NOT NULL, admission_order TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued', 'completed', 'failed')),
          retry_eligible INTEGER NOT NULL CHECK(retry_eligible IN (0, 1)), diagnostic TEXT,
          CHECK ((state = 'queued' AND retry_eligible = 1 AND diagnostic IS NULL)
            OR (state = 'completed' AND retry_eligible = 0 AND diagnostic IS NULL)
            OR (state = 'failed' AND diagnostic IS NOT NULL AND length(trim(diagnostic)) > 0))
        );
      `);
      // Triggers keep each mutation and its generation in the same transaction,
      // including existing single-statement manual proposal/application writes.
      for (const table of ['sources', 'reviewed_boundaries', 'proposals']) {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          this.db.exec(`DROP TRIGGER IF EXISTS context_${table}_${operation}`);
          let condition = '';
          if (table === 'sources' && operation === 'INSERT')
            condition = 'WHEN NEW.seed_since IS NOT NULL';
          if (table === 'sources' && operation === 'UPDATE')
            condition = 'WHEN NEW.seed_since IS NOT OLD.seed_since';
          this.db.exec(`CREATE TRIGGER context_${table}_${operation}
            AFTER ${operation} ON ${table} ${condition} BEGIN
              UPDATE review_context SET generation = generation + 1
              ${table === 'proposals' ? ', notice_generation = notice_generation + 1' : ''}
              WHERE singleton = 1;
            END`);
        }
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) < 1) {
        const update = this.db.prepare('UPDATE proposals SET revision = ?, body = ? WHERE id = ?');
        for (const row of this.db.prepare('SELECT id, revision, body FROM proposals').iterate()) {
          const proposal = JSON.parse(row['body'] as string) as Proposal & { history?: unknown };
          const sources = unionProposalSources(proposal.sources);
          if (!Object.hasOwn(proposal, 'history') && sources.length === proposal.sources.length)
            continue;
          delete proposal.history;
          proposal.sources = sources;
          proposal.revision = Number(row['revision']) + 1;
          update.run(proposal.revision, JSON.stringify(proposal), row['id'] as string);
        }
        this.db.exec('PRAGMA user_version = 1');
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!['user_version']) < 2) {
        this.db.exec(`
          ALTER TABLE capture_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK(attempt_count >= 0 AND attempt_count <= ${CAPTURE_MAX_ATTEMPTS});
          ALTER TABLE capture_jobs ADD COLUMN active_attempt_id TEXT;
          ALTER TABLE capture_jobs ADD COLUMN next_attempt_at INTEGER;
          ALTER TABLE capture_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
          CREATE TABLE capture_control (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            paused INTEGER NOT NULL CHECK(paused IN (0, 1))
          );
          INSERT INTO capture_control (singleton, paused) VALUES (1, 0);
          UPDATE capture_jobs SET state = 'failed', retry_eligible = 0,
            diagnostic = CASE WHEN diagnostic IS NULL THEN '' ELSE diagnostic || '; ' END
              || 'Historical attempts unknown; explicit retry required'
            WHERE state <> 'completed';
          PRAGMA user_version = 2;
        `);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } finally {
        this.db.close();
      }
      throw error;
    }
  }

  // A separate lock file lets other Pi sessions enroll during an interactive review.
  // SQLite releases this transaction's OS lock on close, including process death.
  claimReview(): void {
    this.claimReviewLock();
    try {
      this.db.exec('UPDATE review_context SET generation = generation + 1 WHERE singleton = 1');
    } catch (error) {
      this.releaseReview();
      throw error;
    }
  }

  private claimReviewLock(): void {
    if (this.reviewLock) throw new Error('A remembrancer review is already open');
    const lock = openPrivate(this.filename === ':memory:' ? ':memory:' : this.filename + '.lock');
    try {
      lock.exec('BEGIN IMMEDIATE');
    } catch (error) {
      lock.close();
      if ((error as { errcode?: number }).errcode === 5)
        throw new Error('A remembrancer review is already open in another Pi process');
      throw error;
    }
    this.reviewLock = lock;
  }

  releaseReview(): void {
    this.reviewLock?.close();
    this.reviewLock = undefined;
  }

  proposals(state?: ProposalState, offset = 0, limit = 50): Proposal[] {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Invalid proposal page');
    const rows =
      state === undefined
        ? this.db
            .prepare('SELECT body FROM proposals ORDER BY rowid LIMIT ? OFFSET ?')
            .all(limit, offset)
        : this.db
            .prepare('SELECT body FROM proposals WHERE state = ? ORDER BY rowid LIMIT ? OFFSET ?')
            .all(state, limit, offset);
    return rows.map((row) => JSON.parse(row['body'] as string) as Proposal);
  }

  proposalCount(state: ProposalState = 'pending'): number {
    return Number(
      this.db.prepare('SELECT count(*) AS count FROM proposals WHERE state = ?').get(state)![
        'count'
      ],
    );
  }

  proposal(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT body FROM proposals WHERE id = ?').get(id);
    return row ? (JSON.parse(row['body'] as string) as Proposal) : undefined;
  }

  private saveProposal(proposal: Proposal, expectedRevision?: number): Proposal {
    // Draft decisions have no active application. Outcomes retain their claim and snapshot.
    const { state, claim, result, applicationBefore } = proposal;
    const valid =
      state === 'pending' || state === 'dismissed'
        ? claim === null && result === null && applicationBefore === undefined
        : typeof claim === 'string' &&
          claim.length > 0 &&
          (state === 'applying'
            ? result === null
            : ['applied', 'already_satisfied', 'uncertain'].includes(state) &&
              result?.state === state);
    if (!valid) throw new Error('Invalid proposal application state');
    if (expectedRevision !== undefined) {
      const row = this.db
        .prepare('SELECT revision, body FROM proposals WHERE id = ?')
        .get(proposal.id);
      if (!row || row['revision'] !== expectedRevision)
        throw new Error('Proposal revision conflict');
      const previous = JSON.parse(row['body'] as string) as Proposal;
      if (isDeepStrictEqual(proposal, previous)) return previous;
      proposal.revision = expectedRevision + 1;
      proposal.updatedAt = new Date().toISOString();
    }
    if (expectedRevision === undefined) {
      this.db
        .prepare('INSERT INTO proposals VALUES (?, ?, ?, ?)')
        .run(proposal.id, proposal.revision, proposal.state, JSON.stringify(proposal));
    } else if (
      !this.db
        .prepare(
          'UPDATE proposals SET revision = ?, state = ?, body = ? WHERE id = ? AND revision = ?',
        )
        .run(
          proposal.revision,
          proposal.state,
          JSON.stringify(proposal),
          proposal.id,
          expectedRevision,
        ).changes
    ) {
      throw new Error('Proposal revision conflict');
    }
    return proposal;
  }

  private checkedProposal(id: string, revision: number, states: ProposalState[]): Proposal {
    const value = this.proposal(id);
    if (!value || value.revision !== revision) throw new Error('Proposal revision conflict');
    if (!states.includes(value.state)) throw new Error('Illegal proposal state transition');
    return value;
  }

  editProposal(id: string, revision: number, draft: ProposalDraft): Proposal {
    validateDraft(draft);
    const value = this.checkedProposal(id, revision, ['pending']);
    value.draft = structuredClone(draft);
    return this.saveProposal(value, revision);
  }

  dismissProposal(id: string, revision: number): Proposal {
    const value = this.checkedProposal(id, revision, ['pending']);
    value.state = 'dismissed';
    return this.saveProposal(value, revision);
  }

  claimProposal(id: string, revision: number, before?: TaskSnapshot | null): Proposal {
    if (before) validateSnapshot(before);
    const value = this.checkedProposal(id, revision, ['pending']);
    if ((value.draft ?? value).question !== null)
      throw new Error('Resolve proposal question before applying');
    const change = (value.draft ?? value).change;
    if (before !== undefined) {
      if (change.operation === 'add' ? before !== null : before?.uuid !== change.targetUuid)
        throw new Error('Application snapshot does not match target');
      value.applicationBefore = structuredClone(before);
    }
    value.state = 'applying';
    value.claim = randomUUID();
    value.result = null;
    return this.saveProposal(value, revision);
  }

  recordProposalResult(
    id: string,
    revision: number,
    claim: string,
    result: ApplicationResult,
  ): Proposal {
    const value = this.checkedProposal(id, revision, ['applying', 'uncertain']);
    if (!claim || value.claim !== claim) throw new Error('Application claim mismatch');
    if (!['applied', 'already_satisfied', 'uncertain'].includes(result.state))
      throw new Error('Invalid application result');
    if (result.verified !== null) validateSnapshot(result.verified);
    if (result.state === 'applied' || result.state === 'already_satisfied') {
      if (!result.verified || result.error !== null)
        throw new Error('Success requires verified task');
    } else if (typeof result.error !== 'string' || !result.error.trim())
      throw new Error('Failure requires error');
    const effective = value.draft ?? value;
    if (
      result.verified &&
      effective.change.operation !== 'add' &&
      result.verified.uuid !== effective.change.targetUuid
    )
      throw new Error('Verified task does not match target');
    value.state = result.state;
    value.result = structuredClone(result);
    return this.saveProposal(value, revision);
  }

  private saveCapture(
    capture: ReturnType<CaptureReview['completion']>,
    submissions: readonly ProposalSubmission[],
  ): Proposal[] {
    const enrolled = new Map(this.sources().map((source) => [source.sessionId, source.file]));
    const plan = this.normalizePlan({
      ...capture.plan,
      sources: (capture.plan.sources ?? []).map((source) => ({
        ...source,
        file: enrolled.get(source.sessionId) ?? source.file,
      })),
    });
    const saved: Proposal[] = [];
    const ids = new Set<string>();
    for (const [index, submission] of submissions.entries()) {
      const references = capture.sources[index]!;
      const now = new Date().toISOString();
      let proposal: Proposal;
      if (submission.id !== undefined) {
        if (ids.has(submission.id)) throw new Error('Repeated proposal revision');
        ids.add(submission.id);
        const previous = this.proposal(submission.id);
        if (!previous || previous.revision !== submission.expectedRevision)
          throw new CaptureRetryableError('Proposal revision conflict');
        if (previous.state !== 'pending')
          throw new CaptureRetryableError('Illegal proposal state transition');
        const conflict =
          'New evidence conflicts with an edited draft. Review both before applying.';
        proposal = {
          ...previous,
          change: submission.change,
          expected: submission.expected,
          question: submission.question,
          explanation: submission.explanation,
          sources: unionProposalSources(previous.sources, references),
        };
        if (
          proposal.draft &&
          !isDeepStrictEqual(proposal, {
            ...previous,
            sources: unionProposalSources(previous.sources),
          })
        ) {
          proposal.draft = { ...proposal.draft, question: conflict };
        }
      } else {
        proposal = {
          id: randomUUID(),
          revision: 1,
          change: submission.change,
          expected: submission.expected,
          question: submission.question,
          draft: null,
          explanation: submission.explanation,
          sources: references,
          state: 'pending',
          claim: null,
          result: null,
          createdAt: now,
          updatedAt: now,
        };
      }
      saved.push(this.saveProposal(proposal, submission.expectedRevision));
    }

    this.writeCoverage(plan);
    return saved;
  }

  contextGeneration(): number {
    return Number(
      this.db.prepare('SELECT generation FROM review_context WHERE singleton = 1').get()![
        'generation'
      ],
    );
  }

  proposalNotice(): { generation: number; pending: number } {
    const row = this.db
      .prepare(
        `SELECT notice_generation AS generation,
      (SELECT count(*) FROM proposals WHERE state = 'pending') AS pending
      FROM review_context WHERE singleton = 1`,
      )
      .get()!;
    return { generation: Number(row['generation']), pending: Number(row['pending']) };
  }

  claimCaptureWorker(): CaptureWorkerOwnership {
    return CaptureWorkerOwnership.claim(this.filename);
  }

  captureJob(id: string): CaptureJob | undefined {
    const row = this.db.prepare('SELECT * FROM capture_jobs WHERE id = ?').get(id);
    if (!row) return undefined;
    return {
      manifest: JSON.parse(row['body'] as string) as ReadyManifest,
      state: row['state'] as CaptureJob['state'],
      retryEligible: Boolean(row['retry_eligible']),
      diagnostic: row['diagnostic'] as string | null,
      attemptCount: Number(row['attempt_count']),
      activeAttemptId: row['active_attempt_id'] as string | null,
      nextAttemptAt: row['next_attempt_at'] as number | null,
      revision: Number(row['revision']),
    };
  }

  captureStatus(): CaptureStatus {
    const jobs = this.db
      .prepare(
        `SELECT job.id, (${predecessor}) AS blocked_by FROM capture_jobs AS job
        WHERE job.state <> 'completed' ORDER BY job.admission_order`,
      )
      .all()
      .map((row) => ({
        ...this.captureJob(row['id'] as string)!,
        blockedBy: row['blocked_by'] as string | null,
      }));
    return { paused: this.capturePaused(), jobs };
  }

  private capturePaused(): boolean {
    return Boolean(
      this.db.prepare('SELECT paused FROM capture_control WHERE singleton = 1').get()!['paused'],
    );
  }

  setCapturePaused(paused: boolean, nowMs = Date.now()): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE capture_control SET paused = ? WHERE singleton = 1')
        .run(Number(paused));
      if (paused) this.interruptCaptureAttempts('Capture interrupted by pause', nowMs);
    });
  }

  retryCaptureJob(id: string, expectedRevision: number): CaptureJob {
    return this.transaction(() => {
      const job = this.captureJob(id);
      if (
        !job ||
        job.state !== 'failed' ||
        job.retryEligible ||
        job.activeAttemptId !== null ||
        job.revision !== expectedRevision
      )
        throw Error('Capture retry confirmation is stale or job is not stopped');
      this.db
        .prepare(
          `UPDATE capture_jobs SET state = 'queued', retry_eligible = 1,
        diagnostic = NULL, attempt_count = 0, next_attempt_at = NULL, revision = revision + 1
        WHERE id = ?`,
        )
        .run(id);
      return this.captureJob(id)!;
    });
  }

  completedCaptureJobIds(owner: CaptureWorkerOwnership): string[] {
    owner.assertStore(this.filename);
    return this.db
      .prepare("SELECT id FROM capture_jobs WHERE state = 'completed' ORDER BY rowid")
      .all()
      .map((row) => row['id'] as string);
  }

  unresolvedSnapshot(snapshot: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM capture_jobs WHERE snapshot = ? AND state <> 'completed' LIMIT 1")
      .get(snapshot);
  }

  importCaptureJob(owner: CaptureWorkerOwnership, value: ReadyManifest): CaptureJob {
    owner.assertStore(this.filename);
    const manifest = validateReadyManifest(value, dirname(value.snapshot));
    return this.transaction(() => {
      owner.assertStore(this.filename);
      const existing = this.captureJob(manifest.id);
      if (!existing || existing.state !== 'completed') {
        const snapshot = statSync(manifest.snapshot);
        if (!snapshot.isFile() || snapshot.size !== manifest.source.bytes)
          throw Error('Retained snapshot extent differs from handoff');
      }
      if (existing) {
        if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest))
          throw Error('Handoff ID metadata conflict');
        return existing;
      }
      // Publication sequences belong to one durable inbox, not the importer or
      // the wall clock. Never compare counters from different inboxes.
      const previous = this.db.prepare('SELECT snapshot FROM capture_jobs LIMIT 1').get();
      if (
        previous &&
        physicalInbox(dirname(previous['snapshot'] as string)) !==
          physicalInbox(dirname(manifest.snapshot))
      )
        throw Error('Capture publication order requires one inbox per database');
      if (
        this.db
          .prepare('SELECT 1 FROM capture_jobs WHERE admission_order = ?')
          .get(manifest.admissionOrder)
      )
        throw Error('Conflicting capture publication order');
      this.db
        .prepare(
          `INSERT INTO capture_jobs
          (id, session_id, snapshot, accepted_at, admission_order, body, state,
           retry_eligible, diagnostic, attempt_count, active_attempt_id, next_attempt_at, revision)
          VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, NULL, 0, NULL, NULL, 1)`,
        )
        .run(
          manifest.id,
          manifest.source.sessionId,
          manifest.snapshot,
          manifest.acceptedAt,
          manifest.admissionOrder,
          JSON.stringify(manifest),
        );
      return this.captureJob(manifest.id)!;
    });
  }

  runnableCaptureJobs(owner: CaptureWorkerOwnership, nowMs = Date.now()): CaptureJob[] {
    owner.assertStore(this.filename);
    return this.runnableCaptureJobIds(nowMs).map((id) => this.captureJob(id)!);
  }

  // Read-only exit-race check. A subsequent claim still grants authority.
  captureRecoveryPending(nowMs = Date.now()): boolean {
    return this.runnableCaptureJobIds(nowMs).length > 0;
  }

  private runnableCaptureJobIds(nowMs: number): string[] {
    // Drain every visible ready signal before selection, regardless of discovery order.
    const first = this.db.prepare('SELECT snapshot FROM capture_jobs LIMIT 1').get();
    if (
      first &&
      readdirSync(dirname(first['snapshot'] as string)).some(
        (name) =>
          name.endsWith('.ready.json') && !this.captureJob(name.slice(0, -'.ready.json'.length)),
      )
    )
      return [];
    return this.db
      .prepare(
        `SELECT job.id FROM capture_jobs AS job
        WHERE (SELECT paused FROM capture_control WHERE singleton = 1) = 0
        AND json_extract(job.body, '$.version') = 3
        AND (job.state = 'queued' OR (job.state = 'failed' AND job.retry_eligible = 1))
        AND job.active_attempt_id IS NULL AND job.attempt_count < ?
        AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ?)
        AND NOT EXISTS (${predecessor}) ORDER BY job.admission_order`,
      )
      .all(CAPTURE_MAX_ATTEMPTS, nowMs)
      .map((row) => row['id'] as string);
  }

  claimCaptureAttempt(
    owner: CaptureWorkerOwnership,
    jobId: string,
    nowMs = Date.now(),
  ): CaptureAttempt | undefined {
    let attempt: CaptureAttempt | undefined;
    try {
      return this.coordinateCapture(owner, () =>
        this.transaction(() => {
          if (!this.runnableCaptureJobIds(nowMs).includes(jobId)) return undefined;
          attempt = owner.startAttempt(jobId);
          this.db
            .prepare(
              `UPDATE capture_jobs SET attempt_count = attempt_count + 1,
          active_attempt_id = ?, state = 'queued', retry_eligible = 1, diagnostic = NULL,
          next_attempt_at = NULL, revision = revision + 1 WHERE id = ?`,
            )
            .run(attempt.id, jobId);
          return attempt;
        }),
      );
    } catch (error) {
      // Never leave an executable in-memory identity after a failed durable commit.
      if (attempt) owner.abandon(attempt);
      throw error;
    }
  }

  assertCaptureAttempt(owner: CaptureWorkerOwnership, attempt: CaptureAttempt): void {
    owner.assertStore(this.filename);
    owner.assertAttempt(attempt);
    // One statement observes identity and pause together, including quick pause/resume.
    if (
      !this.db
        .prepare(
          `SELECT 1 FROM capture_jobs
      WHERE id = ? AND state = 'queued' AND active_attempt_id = ?
      AND (SELECT paused FROM capture_control WHERE singleton = 1) = 0`,
        )
        .get(attempt.jobId, attempt.id)
    )
      throw Error('No matching durable capture attempt');
  }

  recoverInterruptedCaptureAttempts(owner: CaptureWorkerOwnership, nowMs = Date.now()): void {
    owner.assertStore(this.filename);
    this.transaction(() => this.interruptCaptureAttempts('Capture worker interrupted', nowMs));
  }

  private interruptCaptureAttempts(diagnostic: string, nowMs: number): void {
    for (const row of this.db
      .prepare('SELECT id FROM capture_jobs WHERE active_attempt_id IS NOT NULL')
      .all()) {
      const job = this.captureJob(row['id'] as string)!;
      this.writeCaptureFailure(job, diagnostic, true, nowMs);
    }
  }

  private writeCaptureFailure(
    job: CaptureJob,
    diagnostic: string,
    temporary: boolean,
    nowMs: number,
  ): void {
    const retry = temporary && job.attemptCount < CAPTURE_MAX_ATTEMPTS;
    this.db
      .prepare(
        `UPDATE capture_jobs SET state = 'failed', retry_eligible = ?, diagnostic = ?,
      active_attempt_id = NULL, next_attempt_at = ?, revision = revision + 1 WHERE id = ?`,
      )
      .run(
        Number(retry),
        temporary && !retry ? `Capture attempt allowance exhausted: ${diagnostic}` : diagnostic,
        retry ? nowMs + CAPTURE_RETRY_DELAY_MS : null,
        job.manifest.id,
      );
  }

  private coordinateCapture<T>(owner: CaptureWorkerOwnership, operation: () => T): T {
    owner.assertStore(this.filename);
    try {
      this.claimReviewLock();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('A remembrancer review is already open')
      )
        throw new CaptureRetryableError(error.message);
      throw error;
    }
    try {
      return operation();
    } finally {
      this.releaseReview();
    }
  }

  prepareCaptureJob(owner: CaptureWorkerOwnership, attempt: CaptureAttempt): CaptureReview {
    if (this.jobCapture?.attempt === attempt) throw Error('Attempt already has a frozen capture');
    const frozen = this.coordinateCapture(owner, () =>
      this.transaction(() => {
        this.assertCaptureAttempt(owner, attempt);
        const job = this.captureJob(attempt.jobId)!;
        const enrolled = this.sources().find(
          (source) => source.sessionId === job.manifest.source.sessionId,
        );
        return {
          job,
          source: {
            file: job.manifest.source.file,
            sessionId: job.manifest.source.sessionId,
            seedSince: enrolled?.seedSince ?? null,
          },
          liveSourceFile: enrolled?.file ?? job.manifest.source.file,
          reviewed: this.reviewed(),
          generation: this.contextGeneration(),
          body: JSON.stringify(job.manifest),
        };
      }),
    );
    // Parsing and historical applicability are deliberately outside manual ownership.
    const result = prepareHistoricalReview(
      frozen.source,
      frozen.job.manifest.snapshot,
      frozen.reviewed,
      undefined,
      frozen.liveSourceFile,
    );
    this.assertCaptureAttempt(owner, attempt);
    if ('retryEligible' in result) {
      this.failCaptureJob(owner, attempt, result.diagnostic, result.retryEligible);
      throw new CapturePreparationError(result.diagnostic, result.category, result.retryEligible);
    }
    const review = new CaptureReview(result.review, () => {
      this.assertCaptureAttempt(owner, attempt);
      if (this.jobCapture?.review !== review) throw Error('No matching frozen capture job');
    });
    this.jobCapture = { owner, attempt, review, generation: frozen.generation, body: frozen.body };
    return review;
  }

  failCaptureJob(
    owner: CaptureWorkerOwnership,
    attempt: CaptureAttempt,
    diagnostic: string,
    retryEligible: boolean,
    nowMs = Date.now(),
  ): boolean {
    owner.assertStore(this.filename);
    if (!diagnostic.trim()) throw Error('Capture failure requires a diagnostic');
    const failed = this.transaction(() => {
      const job = this.captureJob(attempt.jobId);
      if (!job || job.state !== 'queued' || job.activeAttemptId !== attempt.id) return false;
      owner.assertAttempt(attempt);
      this.writeCaptureFailure(job, diagnostic, retryEligible, nowMs);
      return true;
    });
    if (failed) {
      this.jobCapture = undefined;
      owner.abandon(attempt);
    }
    return failed;
  }

  finishCaptureJob(
    owner: CaptureWorkerOwnership,
    attempt: CaptureAttempt,
    submissions: readonly ProposalSubmission[],
  ): Proposal[] {
    const saved = this.coordinateCapture(owner, () =>
      this.transaction(() => {
        this.assertCaptureAttempt(owner, attempt);
        const active = this.jobCapture;
        const job = this.captureJob(attempt.jobId);
        if (
          !active ||
          active.owner !== owner ||
          active.attempt !== attempt ||
          !job ||
          job.state !== 'queued' ||
          JSON.stringify(job.manifest) !== active.body ||
          this.db
            .prepare(
              `SELECT (${predecessor}) AS blocked_by FROM capture_jobs AS job WHERE job.id = ?`,
            )
            .get(attempt.jobId)!['blocked_by'] !== null
        )
          throw Error('No matching durable capture job');
        validateReadyManifest(job.manifest, dirname(job.manifest.snapshot));
        if (this.contextGeneration() !== active.generation)
          throw new CaptureRetryableError('Capture review context changed; reprepare');
        const capture = active.review.completion(submissions);
        const proposals = this.saveCapture(capture, submissions);
        this.db
          .prepare(
            `UPDATE capture_jobs SET state = 'completed', retry_eligible = 0, diagnostic = NULL,
              active_attempt_id = NULL, next_attempt_at = NULL, revision = revision + 1 WHERE id = ?`,
          )
          .run(attempt.jobId);
        return proposals;
      }),
    );
    this.jobCapture = undefined;
    owner.abandon(attempt);
    return saved;
  }

  enroll(sessionId: string, file: string): void {
    this.db
      .prepare(
        `INSERT INTO sources (session_id, session_file) VALUES (?, ?)
      ON CONFLICT (session_id) DO UPDATE SET session_file = excluded.session_file`,
      )
      .run(sessionId, file);
  }

  sources(): StoredSource[] {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, session_file AS file, seed_since AS seedSince
         FROM sources ORDER BY rowid`,
      )
      .all() as unknown as StoredSource[];
  }

  reviewed(): Checkpoint[] {
    return this.db
      .prepare(
        `SELECT tip.session_id AS sessionId, tip.tip_id AS entryId,
                source.session_file AS file, tip.since AS since
         FROM reviewed_boundaries AS tip
         JOIN sources AS source USING (session_id)
         ORDER BY tip.rowid`,
      )
      .all() as unknown as Checkpoint[];
  }

  finish(tips: readonly Tip[]): void;
  finish(plan: FinishPlan): void;
  finish(input: readonly Tip[] | FinishPlan): void {
    const plan: FinishPlan = Array.isArray(input)
      ? { checkpoints: input.map(checkpointFromTip) }
      : (input as FinishPlan);
    const normalized = this.normalizePlan(plan);
    this.transaction(() => this.writeCoverage(normalized));
  }

  private normalizePlan(plan: FinishPlan) {
    const sources = plan.sources ?? [];
    const sourceDefaults = (plan.sourceDefaults ?? []).map((source) => ({
      ...source,
      since: absoluteTimestamp(source.since),
    }));
    const checkpoints = (plan.checkpoints ?? []).map((checkpoint) => {
      const candidate = checkpoint as Tip & { since?: string | null };
      return { ...checkpoint, since: absoluteTimestamp(candidate.since) };
    });

    for (const source of sources) {
      if (!source.sessionId || !source.file) throw new Error('Cannot finish an invalid source');
      absoluteTimestamp(source.seedSince);
    }
    for (const source of sourceDefaults) {
      if (!source.sessionId || source.since === null)
        throw new Error('Cannot finish an invalid source default');
    }
    for (const checkpoint of checkpoints) {
      if (!checkpoint.sessionId || !checkpoint.entryId)
        throw new Error('Cannot finish an invalid checkpoint');
    }

    return { sources, sourceDefaults, checkpoints };
  }

  // Does not own a transaction. Manual finish and capture completion share only
  // this normalized coverage write, never each other's completion lifecycle.
  private writeCoverage({
    sources,
    sourceDefaults,
    checkpoints,
  }: ReturnType<CheckpointStore['normalizePlan']>): void {
    const known = new Set(this.sources().map((source) => source.sessionId));
    const enroll = this.db.prepare(
      `INSERT INTO sources (session_id, session_file, seed_since) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           session_file = excluded.session_file,
           seed_since = CASE
             WHEN excluded.seed_since IS NULL THEN sources.seed_since
             WHEN sources.seed_since IS NULL THEN excluded.seed_since
             WHEN excluded.seed_since < sources.seed_since THEN excluded.seed_since
             ELSE sources.seed_since
           END`,
    );
    for (const source of sources) {
      enroll.run(source.sessionId, source.file, absoluteTimestamp(source.seedSince));
      known.add(source.sessionId);
    }

    const saveDefault = this.db.prepare(
      `UPDATE sources SET seed_since = CASE
           WHEN seed_since IS NULL OR ? < seed_since THEN ?
           ELSE seed_since
         END
         WHERE session_id = ?`,
    );
    for (const source of sourceDefaults) {
      if (!known.has(source.sessionId)) throw new Error('Cannot finish an unknown source default');
      saveDefault.run(source.since, source.since, source.sessionId);
    }

    const mark = this.db.prepare(
      `INSERT INTO reviewed_boundaries (session_id, tip_id, since) VALUES (?, ?, ?)
         ON CONFLICT (session_id, tip_id) DO UPDATE SET
           since = CASE
             WHEN reviewed_boundaries.since IS NULL OR excluded.since IS NULL THEN NULL
             WHEN excluded.since < reviewed_boundaries.since THEN excluded.since
             ELSE reviewed_boundaries.since
           END`,
    );
    for (const checkpoint of checkpoints) {
      if (!known.has(checkpoint.sessionId)) throw new Error('Cannot finish an unknown checkpoint');
      mark.run(checkpoint.sessionId, checkpoint.entryId, checkpoint.since);
    }
  }

  private transaction<T>(write: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.releaseReview();
    if (this.jobCapture) {
      try {
        this.jobCapture.owner.abandon(this.jobCapture.attempt);
      } catch {
        /* Ownership release already invalidated the attempt. */
      }
      this.jobCapture = undefined;
    }
    this.db.close();
  }
}
