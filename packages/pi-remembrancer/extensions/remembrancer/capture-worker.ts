import { spawn } from 'node:child_process';
import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CheckpointStore } from './checkpoints.js';
import {
  CaptureWorkerOwnership,
  CapturePreparationError,
  type CaptureAttempt,
} from './capture-jobs.js';
import {
  cleanupCompletedSnapshot,
  CaptureHandoffError,
  importReadyHandoff,
  type HandoffInput,
} from './capture-handoff.js';
import { CAPTURE_BUDGET_MS, reviewPreparedCapture } from './capture.js';
import { getPackageDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ProposalSubmission } from './proposals.js';
import { publishProposalNotice } from './capture-notices.js';

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
      [
        'A capture worker already owns this database',
        'A remembrancer review is already open',
        'A remembrancer review is already open in another Pi process',
      ].includes(error.message))
  );
}

/** One on-demand drain. No archive discovery and no capture-setting check after admission. */
export async function runCaptureWorker(options: WorkerOptions): Promise<void> {
  const { database, inbox } = options;
  let owner: CaptureWorkerOwnership | undefined = options.owner;
  let store: CheckpointStore | undefined;
  const attempts = new Map<string, number>();
  const deferred = new Set<string>();
  const seenSignals = new Set<string>();
  const blockedSignals = new Set<string>();
  const cleaned = new Set<string>();
  const excluded = () =>
    new Set([
      ...deferred,
      ...[...attempts].filter(([, n]) => n >= ATTEMPTS_PER_RUN).map(([id]) => id),
    ]);
  const diagnose = async (message: string) => {
    try {
      await appendFile(database + '.capture.log', `${new Date().toISOString()} ${message}\n`, {
        mode: 0o600,
      });
    } catch {
      /* Failed diagnostics cannot reject committed work. Durable evidence remains. */
    }
  };
  const localFailure = (phase: string, id: string, error: unknown) =>
    diagnose(new CaptureHandoffError(phase, 'local-failure', id, error).message);
  const repairCompleted = async () => {
    try {
      await publishProposalNotice(store!);
    } catch (error) {
      await localFailure('notice-publication', 'store', error);
    }
    for (const id of store!.completedCaptureJobIds(owner!)) {
      if (cleaned.has(id)) continue;
      cleaned.add(id);
      try {
        await cleanupCompletedSnapshot(store!, owner!, id);
      } catch (error) {
        await localFailure('snapshot-cleanup', id, error);
      }
    }
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
    owner.assertStore(store.file);
    for (;;) {
      for (const name of await readyFiles()) {
        if (seenSignals.has(name)) continue;
        seenSignals.add(name);
        const id = /^[\w-]{1,128}\.ready\.json$/.test(name)
          ? name.slice(0, -'.ready.json'.length)
          : 'retained-artifact';
        try {
          const imported = await importReadyHandoff(store, owner, join(inbox, name));
          if (imported.signalCleanupPending)
            await diagnose(imported.cleanupDiagnostic ?? `Capture signal-cleanup pending [${id}]`);
        } catch (error) {
          // Retain unknown evidence. Storage still fences every unimported signal.
          blockedSignals.add(name);
          if (error instanceof CaptureHandoffError) await diagnose(error.message);
          else await localFailure('ready-import', id, error);
        }
      }
      // Completed rows, not ready files or model replay, authorize repair on every wake.
      await repairCompleted();
      const job = store
        .runnableCaptureJobs(owner)
        .find((item) => !excluded().has(item.manifest.id));
      if (!job) {
        // Repair commits arriving during the preceding asynchronous sidecar write.
        await repairCompleted();
        // Invalidate BEFORE release. A new owner object is required on reacquisition.
        owner.release();
        owner = undefined;
        await options.afterRelease?.();
        if (
          !(await readyFiles()).some((name) => !seenSignals.has(name)) &&
          (blockedSignals.size > 0 || !store.captureRecoveryPending(excluded()))
        )
          break;
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
      const expiresAt = performance.now() + (options.budgetMs ?? CAPTURE_BUDGET_MS);
      const previousCwd = process.cwd();
      let fatalTimer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        controller.signal.throwIfAborted();
        currentOwner.assertAttempt(attempt);
        if (performance.now() >= expiresAt) throw Error('Capture review timed out');
      };
      const timer = setTimeout(() => {
        // A never-settling setup/prompt/cleanup must not keep the process alive.
        // This timer cannot run during a CPU stall. It is not a watchdog.
        controller.abort(Error('Capture review timed out'));
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
      let phase = 'evidence-preparation';
      try {
        process.chdir(job.manifest.execution.cwd);
        const current = store.prepareCaptureJob(owner, attempt);
        let submissions: ProposalSubmission[] = [];
        if (current.hasEvidence) {
          const { execution, source } = job.manifest;
          const { runtime } = execution;
          phase = 'reviewer-setup-prompt-cleanup';
          // The SDK caches stored-auth command output process-wide. Clear the
          // selected host's own cache before resolving another project's auth.
          const { clearApiKeyCache } = await import(
            pathToFileURL(join(getPackageDir(), 'dist/core/model-registry.js')).href
          );
          clearApiKeyCache();
          check();
          const settingsManager = SettingsManager.create(execution.cwd, execution.agentDir, {
            projectTrusted: runtime.projectTrusted,
          });
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
          );
        }
        check();
        phase = 'atomic-publication';
        store.finishCaptureJob(owner, attempt, submissions);
        await repairCompleted();
      } catch (error) {
        const contended =
          (phase === 'evidence-preparation' || phase === 'atomic-publication') && busy(error);
        if (contended) deferred.add(id);
        // Classified preparation failures have already persisted and abandoned.
        const diagnostic =
          error instanceof CapturePreparationError
            ? new CaptureHandoffError(phase, error.category, id).message
            : new CaptureHandoffError(phase, 'execution-failure', id, error).message;
        if (isActive(currentOwner, attempt)) {
          store.failCaptureJob(
            currentOwner,
            attempt,
            contended ? 'Manual review contention; deferred' : diagnostic,
            true,
          );
        }
        if (!contended) await diagnose(diagnostic);
      } finally {
        clearTimeout(timer);
        if (fatalTimer) clearTimeout(fatalTimer);
        if (isActive(currentOwner, attempt)) currentOwner.abandon(attempt);
        process.chdir(previousCwd);
      }
    }
  } catch (error) {
    await localFailure('worker', 'store', error);
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
