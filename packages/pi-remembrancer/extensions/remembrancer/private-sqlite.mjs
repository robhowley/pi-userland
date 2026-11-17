import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** @param {string} filename */
export function openPrivateSqlite(filename) {
  if (filename !== ':memory:') {
    // Closing a second descriptor for an existing SQLite file can drop this
    // process's POSIX locks, even those held by another DatabaseSync instance.
    try {
      closeSync(openSync(filename, 'ax', 0o600));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      chmodSync(filename, 0o600);
    }
  }
  return new DatabaseSync(filename);
}
