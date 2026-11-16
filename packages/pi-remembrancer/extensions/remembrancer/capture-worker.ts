import { spawn } from 'node:child_process';
import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckpointStore } from './checkpoints.js';
import { CaptureWorkerOwnership, type CaptureAttempt } from './capture-jobs.js';
import {
  cleanupCompletedSnapshot,
  importReadyHandoff,
  type HandoffInput,
} from './capture-handoff.js';
import { CAPTURE_BUDGET_MS, reviewPreparedCapture } from './capture.js';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ProposalSubmission } from './proposals.js';

const CLEANUP_GRACE_MS = 5_000;
const ATTEMPTS_PER_RUN = 2;

/** A launch acknowledgement means spawned, not imported or completed. Recovery retries later. */
export function launchCaptureWorker(
  database: string,
  inbox: string,
  host: NonNullable<HandoffInput['execution']['host']>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      host.nodeExecutable,
      [
        fileURLToPath(new URL('./capture-worker-bootstrap.mjs', import.meta.url)),
        host.piEntry,
        database,
        inbox,
      ],
      { detached: true, stdio: 'ignore', shell: false },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid!);
    });
  });
}

type WorkerOptions = {
  database: string;
  inbox: string;
  owner?: CaptureWorkerOwnership;
  // Deterministic process/interleaving tests, not user configuration.
  budgetMs?: number;
  graceMs?: number;
  afterRelease?: () => Promise<void>;
  review?: typeof reviewPreparedCapture;
  terminate?: () => never;
};

function busy(error: unknown): boolean {
  return (
    (error as { errcode?: number })?.errcode === 5 ||
    (error instanceof Error &&
      /^A (capture worker already owns|remembrancer review is already open)/.test(error.message))
  );
}

/** One on-demand drain. No archive discovery and no capture-setting check after admission. */
export async function runCaptureWorker(options: WorkerOptions): Promise<void> {
  const { database, inbox } = options;
  let owner: CaptureWorkerOwnership | undefined = options.owner;
  let store: CheckpointStore | undefined;
  const attempts = new Map<string, number>();
  const deferred = new Set<string>();
  const excluded = () =>
    new Set([
      ...deferred,
      ...[...attempts].filter(([, n]) => n >= ATTEMPTS_PER_RUN).map(([id]) => id),
    ]);
  const diagnose = async (message: string) => {
    await appendFile(database + '.capture.log', `${new Date().toISOString()} ${message}\n`, {
      mode: 0o600,
    });
  };
  const readyFiles = async () => {
    try {
      return (await readdir(inbox)).filter((name) => name.endsWith('.ready.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  try {
    if (!owner) {
      try {
        owner = CaptureWorkerOwnership.claim(database);
      } catch (error) {
        if (busy(error)) return;
        throw error;
      }
    }
    store = new CheckpointStore(database);
    for (;;) {
      for (const name of await readyFiles()) {
        const job = await importReadyHandoff(store, owner, join(inbox, name));
        if (job.state === 'completed')
          await cleanupCompletedSnapshot(store, owner, job.manifest.id);
      }
      const job = store
        .runnableCaptureJobs(owner)
        .find((item) => !excluded().has(item.manifest.id));
      if (!job) {
        // Invalidate BEFORE release. A new owner object is required on reacquisition.
        owner.release();
        owner = undefined;
        await options.afterRelease?.();
        if (!(await readyFiles()).length && !store.captureRecoveryPending(excluded())) break;
        try {
          owner = CaptureWorkerOwnership.claim(database);
        } catch (error) {
          if (busy(error)) break;
          throw error;
        }
        continue;
      }
      const id = job.manifest.id;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      const attempt = owner.startAttempt(id);
      const currentOwner = owner;
      const controller = new AbortController();
      let active = true;
      let fatalTimer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        controller.signal.throwIfAborted();
        currentOwner.assertAttempt(attempt);
        if (!active) throw Error('Capture attempt ended');
      };
      const timer = setTimeout(() => {
        // A never-settling setup/prompt/cleanup must not keep the process alive.
        // This timer cannot run during a CPU stall. It is not a watchdog.
        controller.abort(Error('Capture review timed out'));
        active = false;
        try {
          store!.failCaptureJob(currentOwner, attempt, 'Capture review timed out', true);
        } catch {
          /* A completed or invalidated attempt cannot publish again. */
        }
        fatalTimer = setTimeout(() => {
          currentOwner.release();
          (options.terminate ?? (() => process.exit(1)))();
        }, options.graceMs ?? CLEANUP_GRACE_MS);
      }, options.budgetMs ?? CAPTURE_BUDGET_MS);
      let phase = 'Evidence preparation';
      try {
        const current = store.prepareCaptureJob(owner, attempt);
        if (current.incomplete) throw Error('Cannot capture incomplete evidence');
        let submissions: ProposalSubmission[] = [];
        if (current.hasEvidence) {
          const { execution, source } = job.manifest;
          if (!execution.runtime) throw Error('Capture handoff lacks originating reviewer runtime');
          const { runtime } = execution;
          const settingsManager = SettingsManager.create(execution.cwd, execution.agentDir, {
            projectTrusted: runtime.projectTrusted,
          });
          phase = 'Reviewer setup/prompt/cleanup';
          // Raw model headers can be credentials. Re-resolve their originating
          // configuration references, without a catalog lookup or storing values.
          let modelRuntime;
          if (runtime.headerNames?.length) {
            modelRuntime = await ModelRuntime.create({
              authPath: join(execution.agentDir, 'auth.json'),
              modelsPath: join(execution.agentDir, 'models.json'),
              refreshOnCreate: false,
              signal: controller.signal,
            });
            const auth = await modelRuntime.getAuth(runtime.model, { signal: controller.signal });
            const available = new Set(
              Object.keys(auth?.auth.headers ?? {}).map((name) => name.toLowerCase()),
            );
            if (runtime.headerNames.some((name) => !available.has(name.toLowerCase())))
              throw Error('Originating model headers are unavailable from Pi configuration');
          }
          submissions = await (options.review ?? reviewPreparedCapture)(
            current,
            store,
            {
              cwd: execution.cwd,
              agentDir: execution.agentDir,
              model: runtime.model,
              thinkingLevel: runtime.thinkingLevel,
              settingsManager,
              ...(modelRuntime ? { modelRuntime } : {}),
              sessionId: source.sessionId,
              signal: controller.signal,
            },
            check,
            (proposals) => {
              check();
              current.completion(proposals);
            },
          );
        }
        check();
        phase = 'Atomic publication';
        store.finishCaptureJob(owner, attempt, submissions);
        active = false;
        phase = 'Snapshot cleanup';
        await cleanupCompletedSnapshot(store, owner, id);
      } catch (error) {
        const contended = busy(error);
        if (contended) deferred.add(id);
        // prepareHistoricalReview may already have failed/invalidated this identity.
        if (isActive(currentOwner, attempt)) {
          store.failCaptureJob(
            currentOwner,
            attempt,
            contended
              ? 'Manual review contention; deferred'
              : `${phase} failed (${error instanceof Error ? error.name : 'unknown error'})`,
            true,
          );
        }
        if (!contended)
          await diagnose(
            `Job ${id}: ${phase} failed (${error instanceof Error ? error.name : 'unknown error'})`,
          );
      } finally {
        active = false;
        clearTimeout(timer);
        if (fatalTimer) clearTimeout(fatalTimer);
        if (isActive(currentOwner, attempt)) currentOwner.abandon(attempt);
      }
    }
  } catch (error) {
    await diagnose(`Worker failed (${error instanceof Error ? error.name : 'unknown error'})`);
    throw error;
  } finally {
    owner?.release();
    store?.close();
  }
}

function isActive(owner: CaptureWorkerOwnership, attempt: CaptureAttempt): boolean {
  try {
    owner.assertAttempt(attempt);
    return true;
  } catch {
    return false;
  }
}
