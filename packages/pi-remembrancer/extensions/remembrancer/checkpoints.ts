import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Source, Tip } from './evidence.js';

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

export class CheckpointStore {
  private db: DatabaseSync;
  private filename: string;
  private reviewLock: DatabaseSync | undefined;

  constructor(filename = defaultFile()) {
    this.filename = filename;
    this.db = openPrivate(filename);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sources (
        session_id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviewed_boundaries (
        session_id TEXT NOT NULL REFERENCES sources(session_id),
        tip_id TEXT NOT NULL CHECK(tip_id <> ''),
        PRIMARY KEY (session_id, tip_id)
      )`);
  }

  // A separate lock file lets other Pi sessions enroll during an interactive review.
  // SQLite releases this transaction's OS lock on close, including process death.
  claimReview(): void {
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

  enroll(sessionId: string, file: string): void {
    this.db
      .prepare(
        `INSERT INTO sources (session_id, session_file) VALUES (?, ?)
      ON CONFLICT (session_id) DO UPDATE SET session_file = excluded.session_file`,
      )
      .run(sessionId, file);
  }

  sources(): Source[] {
    return this.db
      .prepare(`SELECT session_id AS sessionId, session_file AS file FROM sources ORDER BY rowid`)
      .all() as unknown as Source[];
  }

  reviewed(): Tip[] {
    return this.db
      .prepare(
        `SELECT tip.session_id AS sessionId, tip.tip_id AS entryId, source.session_file AS file
      FROM reviewed_boundaries AS tip JOIN sources AS source USING (session_id) ORDER BY tip.rowid`,
      )
      .all() as unknown as Tip[];
  }

  finish(tips: readonly Tip[]): void {
    const mark = this.db.prepare(
      `INSERT INTO reviewed_boundaries (session_id, tip_id)
       SELECT session_id, ? FROM sources WHERE session_id = ?
       ON CONFLICT DO NOTHING`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const tip of tips) {
        if (!tip.entryId || mark.run(tip.entryId, tip.sessionId).changes === 0)
          throw new Error('Cannot finish an unknown checkpoint');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.releaseReview();
    this.db.close();
  }
}
