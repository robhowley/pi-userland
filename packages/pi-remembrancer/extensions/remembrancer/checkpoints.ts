import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Tip } from './capture.js';

export type Checkpoint = Tip;
export type Source = Pick<Tip, 'sessionId' | 'file'> & { signature: string | null };

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
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        tip_id TEXT NOT NULL,
        session_file TEXT NOT NULL,
        reviewed INTEGER NOT NULL DEFAULT 0,
        scan_signature TEXT,
        PRIMARY KEY (session_id, tip_id)
      )`);
  }

  // A separate lock file lets other Pi sessions checkpoint during an interactive review.
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

  capture(tip: Checkpoint): void {
    if (!tip.entryId) throw new Error('Checkpoint entry ID is required');
    this.db
      .prepare(
        `INSERT INTO checkpoints (session_id, tip_id, session_file) VALUES (?, ?, ?)
      ON CONFLICT (session_id, tip_id) DO NOTHING`,
      )
      .run(tip.sessionId, tip.entryId, tip.file);
  }

  enroll(sessionId: string, file: string): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (session_id, tip_id, session_file) VALUES (?, '', ?)
      ON CONFLICT (session_id, tip_id) DO UPDATE SET session_file = excluded.session_file, scan_signature = NULL
      WHERE session_file <> excluded.session_file`,
      )
      .run(sessionId, file);
  }

  sources(): Source[] {
    return this.db
      .prepare(
        `SELECT session_id AS sessionId, session_file AS file, scan_signature AS signature FROM checkpoints
      WHERE tip_id = '' ORDER BY rowid`,
      )
      .all() as unknown as Source[];
  }

  noteScan(sessionId: string, signature: string, file?: string): void {
    this.db
      .prepare(
        `UPDATE checkpoints SET scan_signature = ? WHERE session_id = ? AND tip_id = ''
      AND (? IS NULL OR session_file = ?)`,
      )
      .run(signature, sessionId, file ?? null, file ?? null);
  }

  private list(flag: number): Checkpoint[] {
    return this.db
      .prepare(
        `SELECT tip.session_id AS sessionId, tip.tip_id AS entryId,
      COALESCE(source.session_file, tip.session_file) AS file FROM checkpoints AS tip
      LEFT JOIN checkpoints AS source ON source.session_id = tip.session_id AND source.tip_id = ''
      WHERE tip.reviewed = ? AND tip.tip_id <> '' ORDER BY tip.rowid`,
      )
      .all(flag) as unknown as Checkpoint[];
  }

  pending(): Checkpoint[] {
    return this.list(0);
  }
  reviewed(): Checkpoint[] {
    return this.list(1);
  }

  finish(tips: readonly Checkpoint[]): void {
    const mark = this.db.prepare(
      'UPDATE checkpoints SET reviewed = 1 WHERE session_id = ? AND tip_id = ?',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const tip of tips) {
        if (!tip.entryId || mark.run(tip.sessionId, tip.entryId).changes === 0)
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
