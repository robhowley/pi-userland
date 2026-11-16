import { chmodSync, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ReadyManifest } from './capture-handoff.js';

export type CaptureJob = {
  manifest: ReadyManifest;
  state: 'queued' | 'completed' | 'failed';
  retryEligible: boolean;
  diagnostic: string | null;
};

// One object per acquired OS lock, never recycled after release. An attempt is
// valid only while it is that object's current identity, not merely its job ID.
export type CaptureAttempt = { readonly jobId: string };
const owners = new Map<string, CaptureWorkerOwnership>();

export class CaptureWorkerOwnership {
  private active: CaptureAttempt | undefined;
  private constructor(
    private readonly file: string,
    private readonly lock: DatabaseSync,
  ) {}

  static claim(filename: string): CaptureWorkerOwnership {
    if (filename === ':memory:') throw Error('Worker ownership requires a durable database');
    // Admission after disabled startup may have no foreground database yet.
    // Exclusive synchronous creation cannot drop an existing store's POSIX locks.
    mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(filename, 'ax', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const file = realpathSync(resolve(filename));
    // Never open/close a second descriptor for a lock file owned by this process:
    // POSIX would release all of this process's locks on that inode.
    if (owners.has(file)) throw Error('A capture worker already owns this database');
    const lockFile = file + '.worker-lock';
    mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(lockFile, 'ax', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      chmodSync(lockFile, 0o600);
    }
    const lock = new DatabaseSync(lockFile);
    try {
      lock.exec('BEGIN IMMEDIATE');
    } catch (error) {
      lock.close();
      throw error;
    }
    const owner = new CaptureWorkerOwnership(file, lock);
    owners.set(file, owner);
    return owner;
  }

  assertStore(filename: string): void {
    if (owners.get(this.file) !== this || realpathSync(resolve(filename)) !== this.file)
      throw Error('No matching capture worker ownership');
  }

  startAttempt(jobId: string): CaptureAttempt {
    if (owners.get(this.file) !== this) throw Error('Capture worker ownership was released');
    if (this.active) throw Error('A capture attempt is already active');
    this.active = Object.freeze({ jobId });
    return this.active;
  }

  assertAttempt(attempt: CaptureAttempt): void {
    if (owners.get(this.file) !== this || this.active !== attempt)
      throw Error('No matching active capture attempt');
  }

  abandon(attempt: CaptureAttempt): void {
    this.assertAttempt(attempt);
    this.active = undefined;
  }

  release(): void {
    // Invalidate callbacks BEFORE closing the descriptor, even if close fails.
    this.active = undefined;
    if (owners.get(this.file) !== this) return;
    owners.delete(this.file);
    this.lock.close();
  }
}
