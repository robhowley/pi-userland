// Storage/crash fixture only. No SDK session, provider, Taskwarrior, or runtime.
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore } from '../../extensions/remembrancer/checkpoints.ts';
import {
  cleanupCompletedSnapshot,
  importReadyHandoff,
} from '../../extensions/remembrancer/capture-handoff.ts';

const [path, ready, stopAt, marker] = process.argv.slice(2);
function stop(point) {
  if (point !== stopAt) return;
  writeFileSync(marker, point);
  // A synchronous crash boundary inside SQLite's write transaction. Parent kills
  // this process; no rollback/cleanup code gets an opportunity to run.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const store = new CheckpointStore(path);
// One-shot cross-process store transitions on disposable databases.
if (stopAt.startsWith('control-')) {
  let result;
  if (stopAt === 'control-pause') store.setCapturePaused(true, Number(marker));
  else if (stopAt === 'control-resume') store.setCapturePaused(false);
  else if (stopAt === 'control-retry') result = store.retryCaptureJob(ready, Number(marker));
  else {
    const owner = store.claimCaptureWorker();
    if (stopAt === 'control-recover')
      store.recoverInterruptedCaptureAttempts(owner, Number(marker));
    else if (stopAt === 'control-claim')
      result = store.claimCaptureAttempt(owner, ready, Number(marker));
    else throw Error(`Unknown store action: ${stopAt}`);
    owner.release();
  }
  process.stdout.write(JSON.stringify(result ?? null) + '\n');
  store.close();
  process.exit(0);
}
const owner = store.claimCaptureWorker();
const originalExec = DatabaseSync.prototype.exec;
let finishing = false;
let claiming = false;
DatabaseSync.prototype.exec = function (sql) {
  const result = originalExec.call(this, sql);
  if (sql === 'COMMIT')
    stop(finishing ? 'completion-commit' : claiming ? 'attempt-commit' : 'import-commit');
  return result;
};
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  const originalRun = statement.run;
  statement.run = function (...args) {
    const result = originalRun.apply(this, args);
    if (sql.includes('INSERT INTO capture_jobs')) stop('import-insert');
    if (finishing) {
      if (sql.includes('INSERT INTO proposals')) stop('proposal');
      if (sql.includes('INSERT INTO reviewed_boundaries')) stop('coverage');
      if (sql.includes("SET state = 'completed'")) stop('job-completed');
    }
    return result;
  };
  return statement;
};
await importReadyHandoff(store, owner, ready);
stop('manifest-removed');
claiming = true;
const attempt = store.claimCaptureAttempt(owner, 'first');
claiming = false;
const review = store.prepareCaptureJob(owner, attempt);
let page;
do {
  page = review.page();
} while (page.hasMore);
stop('prepared');
finishing = true;
store.finishCaptureJob(owner, attempt, [
  {
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
  },
]);
await cleanupCompletedSnapshot(store, owner, 'first');
stop('cleanup');
throw Error(`Unreached crash boundary: ${stopAt}`);
