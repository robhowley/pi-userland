// The caller quiesces the outgoing saved session before admission. No transcript
// parsing or hashing occurs on this asynchronous preservation path.
import { randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  chmod,
  copyFile,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { CheckpointStore } from './checkpoints.js';

// Headers/auth remain in the originating Pi configuration, never in handoffs.
export type CaptureModel = Omit<NonNullable<CreateAgentSessionOptions['model']>, 'headers'>;
export type CaptureRuntime = {
  model: CaptureModel;
  thinkingLevel: NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
  projectTrusted: boolean;
  headerNames?: string[];
};
import type { CaptureJob, CaptureWorkerOwnership } from './capture-jobs.js';

export type HandoffInput = {
  // Fresh randomUUID per admission. Recovery reuses the saved manifest, never
  // preserves another snapshot under an accepted ID.
  id: string;
  inbox: string;
  source: { file: string; sessionId: string };
  execution: {
    cwd: string;
    agentDir: string;
    authorization: { autoCapture: true; disabled: false };
    host?: { nodeExecutable: string; piEntry: string };
    runtime: CaptureRuntime;
  };
};

export const preservationSteps = [
  'source-stat',
  'snapshot-copy',
  'source-verify',
  'snapshot-chmod',
  'snapshot-sync',
  'snapshot-directory-sync',
  'publication-order-write',
  'publication-order-sync',
  'publication-order-rename',
  'publication-order-directory-sync',
  'manifest-write',
  'manifest-sync',
  'manifest-rename',
  'ready-directory-sync',
] as const;
export type PreservationStep = (typeof preservationSteps)[number];
type Hooks = {
  copy?: typeof copyFile;
  before?: (step: PreservationStep) => void | Promise<void>;
  after?: (step: PreservationStep) => void | Promise<void>;
};

async function synchronize(file: string) {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// This queue is also descriptor ownership: closing a second SQLite connection
// to the same inode can release another thread's POSIX locks in this process.
const publications = new Map<string, Promise<void>>();
export const CAPTURE_MANIFEST_VERSION = 3 as const;

const localCodes = new Set([
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EIO',
  'ENOENT',
  'EEXIST',
  'ENOTDIR',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EINVAL',
]);
export class CaptureHandoffError extends Error {
  readonly code: string | undefined;
  constructor(
    readonly phase: string,
    readonly category: string,
    readonly artifactId: string,
    error?: unknown,
  ) {
    const raw = error as { code?: string; errcode?: number } | undefined;
    const code = localCodes.has(raw?.code ?? '')
      ? raw!.code
      : (
          {
            8: 'SQLITE_READONLY',
            10: 'SQLITE_IOERR',
            13: 'SQLITE_FULL',
            14: 'SQLITE_CANTOPEN',
          } as Record<number, string>
        )[raw?.errcode ?? -1];
    super(`Capture ${phase}: ${category}${code ? ` (${code})` : ''} [${artifactId}]`);
    this.code = code;
  }
}

async function claimPublication(inbox: string, id: string) {
  const worker = new Worker(new URL('./capture-publication-lock.mjs', import.meta.url), {
    workerData: join(inbox, '.publication-lock.sqlite'),
    // Do not inherit a foreground loader or command-line evaluation.
    execArgv: [],
  });
  let failure: CaptureHandoffError | undefined;
  let acquired = false;
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on(
        'message',
        (message: { acquired?: boolean; failed?: boolean; code?: string; errcode?: number }) => {
          if (message.failed) {
            failure = new CaptureHandoffError(
              'publication-lock',
              'local-lock-failure',
              id,
              message,
            );
            reject(failure);
          } else if (message.acquired) {
            acquired = true;
            resolve();
          }
        },
      );
      worker.on('error', (error) => {
        failure = new CaptureHandoffError('publication-lock', 'lock-holder-startup', id, error);
        reject(failure);
      });
      worker.once('exit', () => {
        if (!acquired)
          reject(failure ?? new CaptureHandoffError('publication-lock', 'lock-holder-exited', id));
      });
    });
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  return async () => {
    try {
      worker.postMessage('release');
      await exited;
      if (failure) throw failure;
    } finally {
      await worker.terminate();
    }
  };
}

export async function preserveHandoff(request: HandoffInput, hooks: Hooks = {}) {
  const input = structuredClone(request);
  const id = /^[a-zA-Z0-9_-]{1,128}$/.test(input.id) ? input.id : 'invalid-id';
  let phase = 'validation';
  try {
    validateInput(input);
    await validateHeaderReferences(input.execution, id);
    phase = 'inbox-initialization';
    await mkdir(input.inbox, { recursive: true, mode: 0o700 });
    input.inbox = await realpath(input.inbox);
    await chmod(input.inbox, 0o700);
    // Independently persist every ancestor, even when another publisher created
    // it and has not yet synced it. No caller relies on mkdir's created flag.
    for (let directory = input.inbox; ; directory = dirname(directory)) {
      await synchronize(directory);
      if (directory === dirname(directory)) break;
    }
    const previous = publications.get(input.inbox);
    let done!: () => void;
    const current = new Promise<void>((resolve) => (done = resolve));
    publications.set(input.inbox, current);
    await previous;
    try {
      phase = 'publication-lock';
      try {
        await lstat(join(input.inbox, '.publication-lock'));
        throw new CaptureHandoffError(phase, 'legacy-publication-lock', id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const release = await claimPublication(input.inbox, id);
      let accepted: Awaited<ReturnType<typeof preserveOrderedHandoff>> | undefined;
      let cleanupDiagnostic: string | undefined;
      try {
        accepted = await preserveOrderedHandoff(input, hooks);
      } finally {
        try {
          await release();
        } catch (error) {
          if (accepted)
            cleanupDiagnostic = new CaptureHandoffError(
              'publication-lock-release',
              'accepted-cleanup-pending',
              id,
              error,
            ).message;
          // Otherwise preserve the original admission failure, not cleanup.
        }
      }
      return { ...accepted, ...(cleanupDiagnostic ? { cleanupDiagnostic } : {}) };
    } finally {
      done();
      if (publications.get(input.inbox) === current) publications.delete(input.inbox);
    }
  } catch (error) {
    if (error instanceof CaptureHandoffError) throw error;
    throw new CaptureHandoffError(
      phase,
      phase === 'validation' ? 'invalid-input' : 'local-io-failure',
      id,
      error,
    );
  }
}

async function validateHeaderReferences(execution: HandoffInput['execution'], id: string) {
  const required = execution.runtime.headerNames ?? [];
  if (!required.length) return;
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(execution.agentDir, 'models.json'), 'utf8'));
  } catch (error) {
    throw new CaptureHandoffError('validation', 'unavailable-header-references', id, error);
  }
  const provider = (
    config as {
      providers?: Record<
        string,
        {
          headers?: Record<string, unknown>;
          models?: { id: string; headers?: Record<string, unknown> }[];
          modelOverrides?: Record<string, { headers?: Record<string, unknown> }>;
        }
      >;
    } | null
  )?.providers?.[execution.runtime.model.provider];
  const model = provider?.models?.find((model) => model.id === execution.runtime.model.id);
  const headers = {
    ...provider?.headers,
    ...model?.headers,
    ...provider?.modelOverrides?.[execution.runtime.model.id]?.headers,
  };
  const references = new Set(
    Object.entries(headers)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([name]) => name.toLowerCase()),
  );
  if (required.some((name) => !references.has(name.toLowerCase())))
    throw new CaptureHandoffError('validation', 'unsupported-runtime-headers', id);
}

async function preserveOrderedHandoff(input: HandoffInput, hooks: Hooks) {
  const orderFile = join(input.inbox, '.publication-order');
  let previous = '0'.padStart(32, '0');
  try {
    previous = await readFile(orderFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new CaptureHandoffError('publication-order', 'unavailable-order', input.id, error);
    // Never reset ordering around retained evidence, including pre-sequence
    // handoffs. A fresh inbox is the only safe initialization case.
    if (
      (await readdir(input.inbox)).some(
        (name) =>
          !/^\.publication-lock\.sqlite(?:-journal|-wal|-shm)?$/.test(name) &&
          !/^\.publication-order\.[a-f0-9-]{36}\.tmp$/.test(name),
      )
    )
      throw new CaptureHandoffError('publication-order', 'missing-order', input.id);
    // A failed first snapshot must not leave an apparently uninitialized inbox.
    await writeOrder(previous);
  }
  if (!/^\d{32}$/.test(previous))
    throw new CaptureHandoffError('publication-order', 'invalid-order', input.id);
  const admissionOrder = (BigInt(previous) + 1n).toString().padStart(32, '0');
  if (admissionOrder.length !== 32)
    throw new CaptureHandoffError('publication-order', 'order-exhausted', input.id);
  const snapshot = join(input.inbox, `${input.id}.snapshot.jsonl`);
  const temporary = join(input.inbox, `.${input.id}.ready.tmp`);
  const ready = join(input.inbox, `${input.id}.ready.json`);
  // A retained ID must never overwrite a previous ready manifest, even if an
  // operator has removed its snapshot. Exclusive snapshot creation serializes IDs.
  try {
    await stat(ready);
    throw new CaptureHandoffError('snapshot-admission', 'duplicate-handoff', input.id, {
      code: 'EEXIST',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  async function step<T>(name: PreservationStep, operation: () => Promise<T>): Promise<T> {
    try {
      await hooks.before?.(name);
      const value = await operation();
      await hooks.after?.(name);
      return value;
    } catch (error) {
      throw new CaptureHandoffError(
        name,
        name === 'ready-directory-sync' ? 'acceptance-uncertain' : 'preservation-failed',
        input.id,
        error,
      );
    }
  }

  const initial = await step('source-stat', () => stat(input.source.file, { bigint: true }));
  if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CaptureHandoffError('source-stat', 'unsupported-source', input.id);
  const copy = hooks.copy ?? copyFile;
  const copyMode = await step('snapshot-copy', async () => {
    try {
      await copy(
        input.source.file,
        snapshot,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
      );
      return 'clone' as const;
    } catch (error) {
      // Do not mask I/O, space, permission or destination-collision failures.
      if (
        !['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
    await copy(input.source.file, snapshot, constants.COPYFILE_EXCL);
    return 'copy' as const;
  });
  await step('source-verify', async () => {
    const final = await stat(input.source.file, { bigint: true });
    const saved = await stat(snapshot, { bigint: true });
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeNs !== initial.mtimeNs ||
      final.ctimeNs !== initial.ctimeNs ||
      saved.size !== initial.size
    )
      throw Error('Source changed during preservation');
  });
  await step('snapshot-chmod', () => chmod(snapshot, 0o600));
  await step('snapshot-sync', () => synchronize(snapshot));
  await step('snapshot-directory-sync', () => synchronize(input.inbox));

  // Persist the high-water mark before publishing. Gaps after failure are safe;
  // reuse after a restart is not. The lock remains held through ready sync.
  async function writeOrder(order: string, recordSteps = false) {
    const temporary = join(input.inbox, `.publication-order.${randomUUID()}.tmp`);
    const run = async <T>(name: PreservationStep, operation: () => Promise<T>) => {
      if (recordSteps) return step(name, operation);
      try {
        return await operation();
      } catch (error) {
        throw new CaptureHandoffError(
          'publication-order-initialization',
          'initialization-failed',
          input.id,
          error,
        );
      }
    };
    let written = false;
    try {
      await run('publication-order-write', async () => {
        await writeFile(temporary, order, { flag: 'wx', mode: 0o600 });
        written = true;
      });
      await run('publication-order-sync', () => synchronize(temporary));
      await run('publication-order-rename', () => rename(temporary, orderFile));
      await run('publication-order-directory-sync', () => synchronize(input.inbox));
    } finally {
      // Only our private, unpublished scratch. Never remove evidence or the
      // high-water record. A cleanup error must not poison the next admission.
      if (written) await unlink(temporary).catch(() => {});
    }
  }
  await writeOrder(admissionOrder, true);

  // The manifest is the ready signal. Snapshot paths are never source identity.
  const manifest = {
    version: CAPTURE_MANIFEST_VERSION,
    id: input.id,
    snapshot,
    source: {
      file: input.source.file,
      sessionId: input.source.sessionId,
      bytes: Number(initial.size),
      device: String(initial.dev),
      inode: String(initial.ino),
    },
    execution: structuredClone(input.execution),
    acceptedAt: new Date().toISOString(),
    admissionOrder,
  };
  await step('manifest-write', () =>
    writeFile(temporary, JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 }),
  );
  await step('manifest-sync', () => synchronize(temporary));
  await step('manifest-rename', () => rename(temporary, ready));
  let cleanupDiagnostic: string | undefined;
  await step('ready-directory-sync', async () => {
    const directory = await open(input.inbox, 'r');
    try {
      await directory.sync();
    } catch (error) {
      await directory.close().catch(() => {});
      throw error;
    }
    // This sync is the acceptance boundary. Closing its descriptor is cleanup,
    // not another condition on whether the already-synced job was accepted.
    try {
      await directory.close();
    } catch (error) {
      cleanupDiagnostic = new CaptureHandoffError(
        'ready-directory-close',
        'accepted-cleanup-pending',
        input.id,
        error,
      ).message;
    }
  });
  // No cleanup on error: an acknowledgement failure can follow publication.
  // Ambiguous artifacts must be diagnosed, not guessed safe to delete.
  return { manifest, ready, copyMode, ...(cleanupDiagnostic ? { cleanupDiagnostic } : {}) };
}

export type ReadyManifest = Awaited<ReturnType<typeof preserveHandoff>>['manifest'];

function validateInput(input: HandoffInput): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) throw Error('Invalid handoff ID');
  for (const path of [
    input.inbox,
    input.source.file,
    input.execution.cwd,
    input.execution.agentDir,
  ])
    if (!isAbsolute(path)) throw Error('Handoff paths must be absolute');
  if (
    [
      input.source.sessionId,
      input.execution.runtime?.model?.provider,
      input.execution.runtime?.model?.id,
    ].some((value) => typeof value !== 'string' || !value.trim()) ||
    input.execution.authorization?.autoCapture !== true ||
    input.execution.authorization.disabled !== false
  )
    throw Error('Handoff requires originating capture authorization');
  // Serialize only the declared non-secret configuration references.
  const allowed = ['cwd', 'agentDir', 'authorization', 'host', 'runtime'];
  if (
    Object.keys(input.execution).some((key) => !allowed.includes(key)) ||
    Object.keys(input.execution.authorization).some(
      (key) => !['autoCapture', 'disabled'].includes(key),
    )
  )
    throw Error('Unexpected execution metadata');
  {
    const { runtime } = input.execution;
    if (!runtime || !runtime.model) throw Error('Missing reviewer runtime');
    if (
      Object.keys(runtime).some(
        (key) => !['model', 'thinkingLevel', 'projectTrusted', 'headerNames'].includes(key),
      ) ||
      typeof runtime.projectTrusted !== 'boolean' ||
      (runtime.headerNames !== undefined &&
        (!Array.isArray(runtime.headerNames) ||
          runtime.headerNames.some((name) => typeof name !== 'string' || !name.trim()))) ||
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
        runtime.thinkingLevel,
      ) ||
      [
        runtime.model.provider,
        runtime.model.id,
        runtime.model.name,
        runtime.model.api,
        runtime.model.baseUrl,
      ].some((value) => typeof value !== 'string' || !value.trim()) ||
      typeof runtime.model.reasoning !== 'boolean' ||
      !Array.isArray(runtime.model.input) ||
      !runtime.model.input.length ||
      runtime.model.input.some((kind) => !['text', 'image'].includes(kind)) ||
      [
        runtime.model.cost?.input,
        runtime.model.cost?.output,
        runtime.model.cost?.cacheRead,
        runtime.model.cost?.cacheWrite,
      ].some((value) => !Number.isFinite(value) || value < 0) ||
      !Number.isSafeInteger(runtime.model.contextWindow) ||
      runtime.model.contextWindow <= 0 ||
      !Number.isSafeInteger(runtime.model.maxTokens) ||
      runtime.model.maxTokens <= 0 ||
      'headers' in runtime.model ||
      Object.keys(runtime.model).some(
        (key) =>
          ![
            'provider',
            'id',
            'name',
            'api',
            'baseUrl',
            'reasoning',
            'input',
            'cost',
            'contextWindow',
            'maxTokens',
            'thinkingLevelMap',
            'compat',
            'samplingParams',
            'samplingParamsByThinkingLevel',
            'inputLimits',
            'promptCache',
            'type',
          ].includes(key),
      )
    )
      throw Error('Invalid non-secret reviewer runtime');
    const url = new URL(runtime.model.baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw Error('Capture model endpoint must not contain credentials or query parameters');
  }
  if (
    input.execution.host &&
    (Object.keys(input.execution.host).some(
      (key) => !['nodeExecutable', 'piEntry'].includes(key),
    ) ||
      !isAbsolute(input.execution.host.nodeExecutable) ||
      !isAbsolute(input.execution.host.piEntry))
  )
    throw Error('Invalid host references');
}

export function validateReadyManifest(value: unknown, inbox: string): ReadyManifest {
  try {
    const manifest = value as ReadyManifest;
    if (
      !manifest ||
      manifest.version !== CAPTURE_MANIFEST_VERSION ||
      !manifest.source ||
      !manifest.execution ||
      Object.keys(manifest).some(
        (key) =>
          ![
            'version',
            'id',
            'snapshot',
            'source',
            'execution',
            'acceptedAt',
            'admissionOrder',
          ].includes(key),
      ) ||
      Object.keys(manifest.source).some(
        (key) => !['file', 'sessionId', 'bytes', 'device', 'inode'].includes(key),
      )
    )
      throw new CaptureHandoffError(
        'ready-validation',
        'unsupported-or-invalid-manifest',
        'retained',
      );
    validateInput({ ...manifest, inbox });
    if (
      physicalInbox(dirname(manifest.snapshot)) !== physicalInbox(inbox) ||
      manifest.snapshot !== join(dirname(manifest.snapshot), `${manifest.id}.snapshot.jsonl`) ||
      !Number.isSafeInteger(manifest.source.bytes) ||
      manifest.source.bytes < 0 ||
      typeof manifest.source.device !== 'string' ||
      !/^\d+$/.test(manifest.source.device) ||
      typeof manifest.source.inode !== 'string' ||
      !/^\d+$/.test(manifest.source.inode) ||
      !Number.isFinite(Date.parse(manifest.acceptedAt)) ||
      new Date(manifest.acceptedAt).toISOString() !== manifest.acceptedAt ||
      typeof manifest.admissionOrder !== 'string' ||
      !/^\d{32}$/.test(manifest.admissionOrder)
    )
      throw Error('Invalid retained snapshot metadata');
    return manifest;
  } catch (error) {
    if (error instanceof CaptureHandoffError) throw error;
    throw new CaptureHandoffError(
      'ready-validation',
      'invalid-retained-manifest',
      'retained',
      error,
    );
  }
}

// Compare physical directories without rewriting retained payloads/identity JSON.
export function physicalInbox(inbox: string): string {
  return realpathSync(resolve(inbox));
}

async function readReadyManifest(ready: string): Promise<ReadyManifest> {
  try {
    const manifest = validateReadyManifest(
      JSON.parse(await readFile(ready, 'utf8')),
      dirname(ready),
    );
    if (ready !== join(dirname(ready), `${manifest.id}.ready.json`))
      throw Error('Ready filename mismatch');
    return manifest;
  } catch (error) {
    const id =
      /^([a-zA-Z0-9_-]{1,128})\.ready\.json$/.exec(basename(ready))?.[1] ?? 'invalid-ready-name';
    if (error instanceof CaptureHandoffError)
      throw new CaptureHandoffError(error.phase, error.category, id, error);
    throw new CaptureHandoffError('ready-read', 'invalid-or-unavailable-manifest', id, error);
  }
}

// Import is committed before removing the only ready signal. A failed unlink is
// harmless: re-import recognizes the retained ID, including completed jobs.
export async function importReadyHandoff(
  store: CheckpointStore,
  owner: CaptureWorkerOwnership,
  ready: string,
): Promise<{ job: CaptureJob; signalCleanupPending: boolean; cleanupDiagnostic?: string }> {
  owner.assertStore(store.file);
  const manifest = await readReadyManifest(ready);
  const job = store.importCaptureJob(owner, manifest);
  owner.assertStore(store.file);
  try {
    try {
      await unlink(ready);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await synchronize(dirname(ready));
    return { job, signalCleanupPending: false };
  } catch (error) {
    return {
      job,
      signalCleanupPending: true,
      cleanupDiagnostic: new CaptureHandoffError(
        'ready-cleanup',
        'committed-signal-cleanup-pending',
        manifest.id,
        error,
      ).message,
    };
  }
}

// Only explicit completed-job cleanup, not an orphan scanner. Any unreadable or
// ambiguous ready manifest prevents deletion. All unresolved SQLite references
// are checked again after the asynchronous filesystem reads.
export async function cleanupCompletedSnapshot(
  store: CheckpointStore,
  owner: CaptureWorkerOwnership,
  id: string,
): Promise<boolean> {
  owner.assertStore(store.file);
  const job = store.captureJob(id);
  if (!job || job.state !== 'completed') return false;
  const inbox = dirname(job.manifest.snapshot);
  // A hard cutover never makes retained unsupported rows cleanup authority.
  validateReadyManifest(job.manifest, inbox);
  for (const name of await readdir(inbox)) {
    if (!name.endsWith('.ready.json')) continue;
    const manifest = await readReadyManifest(join(inbox, name));
    if (
      join(physicalInbox(dirname(manifest.snapshot)), basename(manifest.snapshot)) ===
      join(physicalInbox(inbox), basename(job.manifest.snapshot))
    )
      return false;
  }
  owner.assertStore(store.file);
  if (
    store.captureJob(id)?.state !== 'completed' ||
    store.unresolvedSnapshot(job.manifest.snapshot)
  )
    return false;
  try {
    await unlink(job.manifest.snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await synchronize(inbox);
  return true;
}
