// SQLite waits off the TUI thread. The transaction is released by close or
// process death, never by deleting the lock file or guessing whether a PID lives.
import { chmodSync, closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';

let database;
try {
  try {
    closeSync(openSync(workerData, 'ax', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    chmodSync(workerData, 0o600);
  }
  database = new DatabaseSync(workerData);
  database.exec('PRAGMA busy_timeout = 1000');
  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (error.errcode !== 5 && error.errcode !== 6) throw error;
      await setTimeout(10);
    }
  }
  parentPort.once('message', () => {
    try {
      database.close();
    } catch (error) {
      parentPort.postMessage({ failed: true, code: error.code, errcode: error.errcode });
    } finally {
      parentPort.close();
    }
  });
  parentPort.postMessage({ acquired: true });
} catch (error) {
  try {
    database?.close();
  } finally {
    parentPort.postMessage({ failed: true, code: error.code, errcode: error.errcode });
    parentPort.close();
  }
}
