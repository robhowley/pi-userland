// The caller quiesces the outgoing saved session before admission. No transcript
// parsing or hashing occurs on this asynchronous preservation path.
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CheckpointStore } from './checkpoints.js';
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
    trustBasis: string;
    model: { provider: string; id: string };
    authorization: { autoCapture: true; disabled: false };
    host?: { nodeExecutable: string; piEntry: string };
    settings?: { userFile: string; projectFile: string | null };
  };
};

export const preservationSteps = [
  'source-stat',
  'snapshot-copy',
  'source-verify',
  'snapshot-chmod',
  'snapshot-sync',
  'snapshot-directory-sync',
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

export async function preserveHandoff(request: HandoffInput, hooks: Hooks = {}) {
  const input = structuredClone(request);
  validateInput(input);
  const firstCreated = await mkdir(input.inbox, { recursive: true, mode: 0o700 });
  await chmod(input.inbox, 0o700);
  if (firstCreated) {
    for (let directory = resolve(input.inbox); ; directory = dirname(directory)) {
      await synchronize(directory);
      if (directory === dirname(resolve(firstCreated))) break;
    }
  }
  const snapshot = join(input.inbox, `${input.id}.snapshot.jsonl`);
  const temporary = join(input.inbox, `.${input.id}.ready.tmp`);
  const ready = join(input.inbox, `${input.id}.ready.json`);
  // A retained ID must never overwrite a previous ready manifest, even if an
  // operator has removed its snapshot. Exclusive snapshot creation serializes IDs.
  try {
    await stat(ready);
    throw Object.assign(Error('Handoff already exists'), { code: 'EEXIST' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  async function step<T>(name: PreservationStep, operation: () => Promise<T>): Promise<T> {
    await hooks.before?.(name);
    const value = await operation();
    await hooks.after?.(name);
    return value;
  }

  const initial = await step('source-stat', () => stat(input.source.file, { bigint: true }));
  if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error('Source is not a supported regular file');
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

  // The manifest is the ready signal. Snapshot paths are never source identity.
  const manifest = {
    version: 1,
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
    // Break same-millisecond admission ties without depending on inbox discovery
    // order. This process clock is shared by processes on the same host/boot.
    admissionOrder: process.hrtime.bigint().toString().padStart(32, '0'),
  };
  await step('manifest-write', () =>
    writeFile(temporary, JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 }),
  );
  await step('manifest-sync', () => synchronize(temporary));
  await step('manifest-rename', () => rename(temporary, ready));
  await step('ready-directory-sync', () => synchronize(input.inbox));
  // No cleanup on error: an acknowledgement failure can follow publication.
  // Ambiguous artifacts must be diagnosed, not guessed safe to delete.
  return { manifest, ready, copyMode };
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
      input.execution.trustBasis,
      input.execution.model.provider,
      input.execution.model.id,
    ].some((value) => typeof value !== 'string' || !value.trim()) ||
    input.execution.authorization?.autoCapture !== true ||
    input.execution.authorization.disabled !== false
  )
    throw Error('Handoff requires originating capture authorization');
  // Serialize only the declared non-secret configuration references.
  const allowed = ['cwd', 'agentDir', 'trustBasis', 'model', 'authorization', 'host', 'settings'];
  if (
    Object.keys(input.execution).some((key) => !allowed.includes(key)) ||
    Object.keys(input.execution.model).some((key) => !['provider', 'id'].includes(key)) ||
    Object.keys(input.execution.authorization).some(
      (key) => !['autoCapture', 'disabled'].includes(key),
    )
  )
    throw Error('Unexpected execution metadata');
  if (
    input.execution.host &&
    (Object.keys(input.execution.host).some(
      (key) => !['nodeExecutable', 'piEntry'].includes(key),
    ) ||
      !isAbsolute(input.execution.host.nodeExecutable) ||
      !isAbsolute(input.execution.host.piEntry))
  )
    throw Error('Invalid host references');
  if (
    input.execution.settings &&
    (Object.keys(input.execution.settings).some(
      (key) => !['userFile', 'projectFile'].includes(key),
    ) ||
      !isAbsolute(input.execution.settings.userFile) ||
      (input.execution.settings.projectFile !== null &&
        !isAbsolute(input.execution.settings.projectFile)))
  )
    throw Error('Invalid settings references');
}

export function validateReadyManifest(value: unknown, inbox: string): ReadyManifest {
  const manifest = value as ReadyManifest;
  if (
    !manifest ||
    manifest.version !== 1 ||
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
    throw Error('Invalid ready manifest');
  validateInput({ ...manifest, inbox });
  if (
    manifest.snapshot !== join(inbox, `${manifest.id}.snapshot.jsonl`) ||
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
    throw Error(`Cannot read ready manifest ${ready}`, { cause: error });
  }
}

// Import is committed before removing the only ready signal. A failed unlink is
// harmless: re-import recognizes the retained ID, including completed jobs.
export async function importReadyHandoff(
  store: CheckpointStore,
  owner: CaptureWorkerOwnership,
  ready: string,
): Promise<CaptureJob> {
  owner.assertStore(store.file);
  const manifest = await readReadyManifest(ready);
  const job = store.importCaptureJob(owner, manifest);
  owner.assertStore(store.file);
  await unlink(ready);
  await synchronize(dirname(ready));
  return job;
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
  for (const name of await readdir(inbox)) {
    if (!name.endsWith('.ready.json')) continue;
    const manifest = await readReadyManifest(join(inbox, name));
    if (manifest.snapshot === job.manifest.snapshot) return false;
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
