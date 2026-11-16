// Phase 0A only. No production API/schema: promote or replace this algorithm in
// capture-handoff.ts before relying on it. The caller must quiesce the outgoing
// session and provision a durable, private inbox. No parsing/hashing occurs here.
import { constants } from 'node:fs';
import { chmod, copyFile, open, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ProofInput = {
  id: string;
  inbox: string;
  source: { file: string; sessionId: string };
  execution: {
    cwd: string;
    agentDir: string;
    trustBasis: string;
    model: { provider: string; id: string };
  };
};

export const proofSteps = [
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
export type ProofStep = (typeof proofSteps)[number];
type Hooks = {
  copy?: typeof copyFile;
  before?: (step: ProofStep) => void | Promise<void>;
  after?: (step: ProofStep) => void | Promise<void>;
};

async function synchronize(file: string) {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function preserveProof(input: ProofInput, hooks: Hooks = {}) {
  const snapshot = join(input.inbox, `${input.id}.snapshot.jsonl`);
  const temporary = join(input.inbox, `.${input.id}.ready.tmp`);
  const ready = join(input.inbox, `${input.id}.ready.json`);
  async function step<T>(name: ProofStep, operation: () => Promise<T>): Promise<T> {
    await hooks.before?.(name);
    const value = await operation();
    await hooks.after?.(name);
    return value;
  }

  const initial = await step('source-stat', () => stat(input.source.file, { bigint: true }));
  if (!initial.isFile()) throw Error('Source is not a regular file');
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

  // The manifest IS the ready signal. Physical bytes and logical source are
  // intentionally different fields. This local shape is not a shared schema.
  const manifest = {
    version: 1,
    id: input.id,
    snapshot,
    source: {
      ...input.source,
      bytes: Number(initial.size),
      device: String(initial.dev),
      inode: String(initial.ino),
    },
    execution: input.execution,
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

export type ProofManifest = Awaited<ReturnType<typeof preserveProof>>['manifest'];
