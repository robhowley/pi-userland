// Storage-only fixture. Admission durability and real publication are tested separately.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import type { CheckpointStore } from '../../extensions/remembrancer/checkpoints.js';
import type { CaptureWorkerOwnership } from '../../extensions/remembrancer/capture-jobs.js';
import type { HandoffInput, ReadyManifest } from '../../extensions/remembrancer/capture-handoff.js';
import type { Source } from '../../extensions/remembrancer/evidence.js';

export const runtime: HandoffInput['execution']['runtime'] = {
  model: {
    provider: 'offline',
    id: 'selected',
    name: 'Offline',
    api: 'openai-completions',
    baseUrl: 'http://localhost:1/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
  },
  thinkingLevel: 'off',
  projectTrusted: true,
};
const owners = new Set<CaptureWorkerOwnership>();
afterEach(() => {
  for (const owner of owners) owner.release();
  owners.clear();
});
export function captureJob(
  store: CheckpointStore,
  source: Pick<Source, 'sessionId' | 'file'>,
  owner = store.claimCaptureWorker(),
) {
  owners.add(owner);
  const id = randomUUID();
  const inbox = join(dirname(store.file), 'inbox');
  mkdirSync(inbox, { recursive: true });
  const snapshot = join(inbox, `${id}.snapshot.jsonl`);
  const original = statSync(source.file);
  copyFileSync(source.file, snapshot);
  const sql = new DatabaseSync(store.file);
  const previous = sql.prepare('SELECT max(admission_order) AS previous FROM capture_jobs').get()![
    'previous'
  ];
  sql.close();
  const admissionOrder = String(BigInt(String(previous ?? '0')) + 1n).padStart(32, '0');
  const manifest: ReadyManifest = {
    version: 3,
    id,
    snapshot,
    source: {
      ...source,
      bytes: original.size,
      device: String(original.dev),
      inode: String(original.ino),
    },
    execution: {
      cwd: dirname(source.file),
      agentDir: dirname(source.file),
      runtime,
      authorization: { autoCapture: true, disabled: false },
    },
    acceptedAt: new Date().toISOString(),
    admissionOrder,
  };
  store.importCaptureJob(owner, manifest);
  const attempt = store.claimCaptureAttempt(owner, id)!;
  const review = store.prepareCaptureJob(owner, attempt);
  return { owner, attempt, review, manifest };
}
