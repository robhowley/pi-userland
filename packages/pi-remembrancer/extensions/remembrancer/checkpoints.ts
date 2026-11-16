import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CaptureReview } from './capture-review.js';
import { CaptureWorkerOwnership, type CaptureAttempt, type CaptureJob } from './capture-jobs.js';
import { validateReadyManifest, type ReadyManifest } from './capture-handoff.js';
import { prepareHistoricalReview } from './evidence.js';
import {
  validateDraft,
  validateSnapshot,
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

function defaultFile(): string {
  const state = process.env['XDG_STATE_HOME'];
  return join(
    state && isAbsolute(state) ? state : join(homedir(), '.local', 'state'),
    'pi-remembrancer',
    'checkpoints.sqlite3',
  );
}

function openPrivate(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    // Closing a second descriptor for an existing SQLite file can drop this
    // process's POSIX locks, even those held by another DatabaseSync instance.
    try {
      closeSync(openSync(filename, 'ax', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      chmodSync(filename, 0o600);
    }
  }
  return new DatabaseSync(filename);
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

export class CheckpointStore {
  private db: DatabaseSync;
  private filename: string;
  private reviewLock: DatabaseSync | undefined;
  private capture: CaptureReview | undefined;
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

  constructor(filename = defaultFile()) {
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
          this.db.exec(`CREATE TRIGGER IF NOT EXISTS context_${table}_${operation}
            AFTER ${operation} ON ${table} BEGIN
              UPDATE review_context SET generation = generation + 1
              ${table === 'proposals' ? ', notice_generation = notice_generation + 1' : ''}
              WHERE singleton = 1;
            END`);
        }
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
    this.capture = undefined;
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

  private saveProposal(proposal: Proposal, expectedRevision?: number): void {
    // Draft decisions have no active application. Outcomes retain the claim and
    // snapshot they describe; previous applications live only in history.
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
  }

  private changedProposal(id: string, revision: number, states: ProposalState[]): Proposal {
    const value = this.proposal(id);
    if (!value || value.revision !== revision) throw new Error('Proposal revision conflict');
    if (!states.includes(value.state)) throw new Error('Illegal proposal state transition');
    const { history = [], ...previous } = value;
    return {
      ...value,
      history: [...history, previous],
      revision: revision + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  editProposal(id: string, revision: number, draft: ProposalDraft): Proposal {
    validateDraft(draft);
    const value = this.changedProposal(id, revision, ['pending']);
    value.draft = structuredClone(draft);
    this.saveProposal(value, revision);
    return value;
  }

  dismissProposal(id: string, revision: number): Proposal {
    const value = this.changedProposal(id, revision, ['pending']);
    value.state = 'dismissed';
    this.saveProposal(value, revision);
    return value;
  }

  claimProposal(id: string, revision: number, before?: TaskSnapshot | null): Proposal {
    if (before) validateSnapshot(before);
    const value = this.changedProposal(id, revision, ['pending']);
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
    this.saveProposal(value, revision);
    return value;
  }

  recordProposalResult(
    id: string,
    revision: number,
    claim: string,
    result: ApplicationResult,
  ): Proposal {
    const value = this.changedProposal(id, revision, ['applying', 'uncertain']);
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
    this.saveProposal(value, revision);
    return value;
  }

  // Capture uses the existing process lock. Its identity is memory-only and has
  // no expiry; the caller releases ownership after reviewer cleanup and commit.
  prepareCapture(source: Pick<Source, 'sessionId' | 'file'>): CaptureReview {
    if (!this.reviewLock) throw new Error('Capture requires review ownership');
    if (this.capture) throw new Error('A capture is already frozen');
    const enrolled = this.sources().find((item) => item.sessionId === source.sessionId);
    const review = new CaptureReview(
      { ...source, seedSince: enrolled?.seedSince ?? null },
      this.reviewed(),
      () => {
        if (!this.reviewLock || this.capture !== review)
          throw new Error('No matching active capture');
      },
    );
    this.capture = review;
    return review;
  }

  private validatedCapture(id: string, submissions: readonly ProposalSubmission[]) {
    if (!this.reviewLock || !this.capture || this.capture.id !== id)
      throw new Error('No matching active capture');
    const frozen = this.capture.completion(submissions);
    this.validateCaptureRevisions(submissions);
    return frozen;
  }

  private validateCaptureRevisions(submissions: readonly ProposalSubmission[]): void {
    const ids = new Set<string>();
    for (const submission of submissions) {
      if (submission.id !== undefined) {
        if (ids.has(submission.id)) throw new Error('Repeated proposal revision');
        ids.add(submission.id);
        this.changedProposal(submission.id, submission.expectedRevision!, ['pending']);
      }
    }
  }

  validateCapture(id: string, submissions: readonly ProposalSubmission[]): void {
    this.validatedCapture(id, submissions);
  }

  finishCapture(id: string, submissions: readonly ProposalSubmission[]): Proposal[] {
    const saved = this.transaction(() => {
      const capture = this.validatedCapture(id, submissions);
      return this.saveCapture(capture, submissions);
    });
    this.capture = undefined;
    return saved;
  }

  private saveCapture(
    capture: ReturnType<CaptureReview['completion']>,
    submissions: readonly ProposalSubmission[],
  ): Proposal[] {
    const plan = this.normalizePlan(capture.plan);
    const saved: Proposal[] = [];
    for (const [index, submission] of submissions.entries()) {
      const references = capture.sources[index]!;
      const now = new Date().toISOString();
      let proposal: Proposal;
      if (submission.id !== undefined) {
        proposal = this.changedProposal(submission.id, submission.expectedRevision!, ['pending']);
        proposal = {
          ...proposal,
          change: submission.change,
          expected: submission.expected,
          question: proposal.draft
            ? 'New evidence conflicts with an edited draft. Review both before applying.'
            : submission.question,
          explanation: submission.explanation,
          sources: [...proposal.sources, ...references],
        };
        if (proposal.draft) proposal.draft = { ...proposal.draft, question: proposal.question };
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
      this.saveProposal(proposal, submission.expectedRevision);
      saved.push(proposal);
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
    const row = this.db
      .prepare('SELECT body, state, retry_eligible, diagnostic FROM capture_jobs WHERE id = ?')
      .get(id);
    if (!row) return undefined;
    return {
      manifest: JSON.parse(row['body'] as string) as ReadyManifest,
      state: row['state'] as CaptureJob['state'],
      retryEligible: Boolean(row['retry_eligible']),
      diagnostic: row['diagnostic'] as string | null,
    };
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
      this.db
        .prepare(`INSERT INTO capture_jobs VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, NULL)`)
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

  runnableCaptureJobs(owner: CaptureWorkerOwnership): CaptureJob[] {
    owner.assertStore(this.filename);
    // An unsuccessful older boundary blocks newer evidence in the same session.
    // Different sessions remain runnable. No snapshot is replaced or coalesced.
    return this.db
      .prepare(
        `SELECT job.id FROM capture_jobs AS job
      WHERE (job.state = 'queued' OR (job.state = 'failed' AND job.retry_eligible = 1))
      AND NOT EXISTS (SELECT 1 FROM capture_jobs AS earlier
        WHERE earlier.session_id = job.session_id
        AND (earlier.accepted_at, earlier.admission_order, earlier.rowid)
          < (job.accepted_at, job.admission_order, job.rowid)
        AND earlier.state <> 'completed') ORDER BY job.accepted_at, job.admission_order, job.rowid`,
      )
      .all()
      .map((row) => this.captureJob(row['id'] as string)!);
  }

  private coordinateCapture<T>(owner: CaptureWorkerOwnership, operation: () => T): T {
    owner.assertStore(this.filename);
    this.claimReviewLock();
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
        owner.assertAttempt(attempt);
        const job = this.captureJob(attempt.jobId);
        if (
          !job ||
          !this.runnableCaptureJobs(owner).some((item) => item.manifest.id === attempt.jobId)
        )
          throw Error('Capture job is not runnable');
        // A crash during execution leaves queued work for the next owner.
        this.db
          .prepare(
            "UPDATE capture_jobs SET state = 'queued', retry_eligible = 1, diagnostic = NULL WHERE id = ?",
          )
          .run(attempt.jobId);
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
    );
    if (!result.review) {
      this.failCaptureJob(owner, attempt, result.diagnostic, true);
      throw Error(result.diagnostic);
    }
    const review = new CaptureReview(
      frozen.source,
      frozen.reviewed,
      () => {
        owner.assertStore(this.filename);
        owner.assertAttempt(attempt);
        if (this.jobCapture?.review !== review) throw Error('No matching frozen capture job');
      },
      result.review,
    );
    this.jobCapture = { owner, attempt, review, generation: frozen.generation, body: frozen.body };
    return review;
  }

  failCaptureJob(
    owner: CaptureWorkerOwnership,
    attempt: CaptureAttempt,
    diagnostic: string,
    retryEligible: boolean,
  ): void {
    owner.assertStore(this.filename);
    owner.assertAttempt(attempt);
    if (!diagnostic.trim()) throw Error('Capture failure requires a diagnostic');
    this.transaction(() => {
      const job = this.captureJob(attempt.jobId);
      if (!job || job.state === 'completed') throw Error('Capture job is not unresolved');
      this.db
        .prepare(
          "UPDATE capture_jobs SET state = 'failed', retry_eligible = ?, diagnostic = ? WHERE id = ?",
        )
        .run(Number(retryEligible), diagnostic, attempt.jobId);
    });
    this.jobCapture = undefined;
    owner.abandon(attempt);
  }

  finishCaptureJob(
    owner: CaptureWorkerOwnership,
    attempt: CaptureAttempt,
    submissions: readonly ProposalSubmission[],
  ): Proposal[] {
    const saved = this.coordinateCapture(owner, () =>
      this.transaction(() => {
        owner.assertAttempt(attempt);
        const active = this.jobCapture;
        const job = this.captureJob(attempt.jobId);
        if (
          !active ||
          active.owner !== owner ||
          active.attempt !== attempt ||
          !job ||
          job.state !== 'queued' ||
          JSON.stringify(job.manifest) !== active.body ||
          !this.runnableCaptureJobs(owner).some((item) => item.manifest.id === attempt.jobId)
        )
          throw Error('No matching durable capture job');
        validateReadyManifest(job.manifest, dirname(job.manifest.snapshot));
        if (this.contextGeneration() !== active.generation)
          throw Error('Capture review context changed; reprepare');
        const capture = active.review.completion(submissions, true);
        this.validateCaptureRevisions(submissions);
        const proposals = this.saveCapture(capture, submissions);
        this.db
          .prepare(
            "UPDATE capture_jobs SET state = 'completed', retry_eligible = 0, diagnostic = NULL WHERE id = ?",
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
