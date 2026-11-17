import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { CaptureWorkerOwnership } from '../extensions/remembrancer/capture-jobs.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: vi.fn(original.open),
    rename: vi.fn(original.rename),
    unlink: vi.fn(original.unlink),
    mkdir: vi.fn(original.mkdir),
    writeFile: vi.fn(original.writeFile),
  };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
import {
  preserveHandoff as preserveProof,
  importReadyHandoff,
  validateReadyManifest,
  physicalInbox,
  preservationSteps as proofSteps,
  type HandoffInput as ProofInput,
  type ReadyManifest as ProofManifest,
  type PreservationStep as ProofStep,
} from '../extensions/remembrancer/capture-handoff.js';

// These assertions exercise production preservation. SIGKILL proves
// process-crash retention, not power-cut or
// storage-controller durability. Real sync calls + ordering assertions cover
// the OS durability protocol; no fsync test can prove hardware flush behavior.
const dirs: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  children.clear();
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(realFs.open);
  vi.mocked(fs.rename).mockImplementation(realFs.rename);
  vi.mocked(fs.unlink).mockImplementation(realFs.unlink);
  vi.mocked(fs.mkdir).mockImplementation(realFs.mkdir);
  vi.mocked(fs.writeFile).mockImplementation(realFs.writeFile);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const original =
  [
    { type: 'session', id: 'outgoing', cwd: '/origin-project' },
    {
      type: 'message',
      id: 'root',
      parentId: null,
      message: { role: 'user', content: 'Keep this commitment: café 🌱' },
    },
    {
      type: 'message',
      id: 'left',
      parentId: 'root',
      message: { role: 'assistant', content: 'Left branch' },
    },
    {
      type: 'context_edit',
      id: 'edit',
      parentId: 'left',
      targetId: 'root',
      replacement: { content: 'Edited commitment' },
    },
    {
      type: 'message',
      id: 'right',
      parentId: 'root',
      message: { role: 'user', content: 'Sibling branch' },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n';

async function fixture(): Promise<ProofInput> {
  const dir = await mkdtemp(join(tmpdir(), 'remembrancer-preservation-proof-'));
  dirs.push(dir);
  const inbox = join(dir, 'inbox');
  await mkdir(inbox, { mode: 0o700 });
  const file = join(dir, 'outgoing.jsonl');
  await writeFile(file, original, { mode: 0o644 });
  return {
    id: 'handoff-a',
    inbox,
    source: { file, sessionId: 'outgoing' },
    execution: {
      cwd: '/origin-project',
      agentDir: '/origin-agent',
      authorization: { autoCapture: true, disabled: false },
      runtime: {
        model: {
          provider: 'offline-fixture',
          id: 'outgoing-model',
          name: 'Offline fixture',
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1234/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 1024,
        },
        thinkingLevel: 'high',
        projectTrusted: true,
      },
    },
  };
}
const ioError = (code: string) => Object.assign(Error(code), { code });
const forceCopy: typeof copyFile = async (source, destination, flags = 0) => {
  if (flags & constants.COPYFILE_FICLONE_FORCE) throw ioError('ENOTSUP');
  await copyFile(source, destination, flags);
};
async function readyNames(input: ProofInput) {
  return (await readdir(input.inbox)).filter((name) => name.endsWith('.ready.json'));
}
async function loadReady(input: ProofInput): Promise<ProofManifest> {
  const names = await readyNames(input);
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(input.inbox, names[0]!), 'utf8'));
}
function observeIO(failSync?: (path: string) => boolean) {
  const events: string[] = [];
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realFs.open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      if (failSync?.(String(args[0]))) throw ioError('EACCES');
      await sync();
      events.push(`sync:${String(args[0])}`);
    });
    return handle;
  });
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await realFs.rename(from, to);
    events.push(`rename:${String(from)}:${String(to)}`);
  });
  return events;
}

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

it.each(['write', 'sync', 'rename'])(
  'recovers after a private ordering scratch %s failure without altering accepted bytes',
  async (failure) => {
    const input = await fixture();
    const first = await preserveProof(input);
    const accepted = await readFile(first.ready, 'utf8');
    const saved = await readFile(first.manifest.snapshot, 'utf8');
    const scratch = (path: unknown) =>
      /\.publication-order\.[a-f0-9-]{36}\.tmp$/.test(String(path));
    if (failure === 'write')
      vi.mocked(fs.writeFile).mockImplementation(async (...args) => {
        await realFs.writeFile(...args);
        if (scratch(args[0])) throw ioError('ENOSPC');
      });
    if (failure === 'sync') observeIO((path) => scratch(path));
    if (failure === 'rename')
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (scratch(from)) throw ioError('EIO');
        await realFs.rename(from, to);
      });
    await expect(preserveProof({ ...input, id: 'failed' })).rejects.toThrow();
    vi.mocked(fs.writeFile).mockImplementation(realFs.writeFile);
    vi.mocked(fs.open).mockImplementation(realFs.open);
    vi.mocked(fs.rename).mockImplementation(realFs.rename);
    const next = await preserveProof({ ...input, id: 'next' });
    expect(BigInt(next.manifest.admissionOrder)).toBeGreaterThan(
      BigInt(first.manifest.admissionOrder),
    );
    expect(await readFile(first.ready, 'utf8')).toBe(accepted);
    expect(await readFile(first.manifest.snapshot, 'utf8')).toBe(saved);
    // A write that failed before confirming ownership may leave private debris.
    // It cannot collide with the next order or justify deleting another file.
    expect(await readdir(input.inbox)).not.toContain('.publication-order.tmp');
  },
);

it('initializes ordering durably before the first snapshot can fail', async () => {
  const input = await fixture();
  await expect(
    preserveProof(input, {
      after: (step) => {
        if (step === 'snapshot-copy') throw ioError('EIO');
      },
    }),
  ).rejects.toMatchObject({ code: 'EIO' });
  expect(await readFile(join(input.inbox, '.publication-order'), 'utf8')).toBe('0'.repeat(32));
  expect(await readFile(join(input.inbox, `${input.id}.snapshot.jsonl`), 'utf8')).toBe(original);
  const next = await preserveProof({ ...input, id: 'next' });
  expect(next.manifest.admissionOrder).toBe('0'.repeat(31) + '1');
});

it.each(['missing', 'corrupt'])(
  'does not reset a %s high-water record around accepted evidence',
  async (kind) => {
    const input = await fixture();
    const first = await preserveProof(input);
    const saved = await readFile(first.ready, 'utf8');
    const snapshot = await readFile(first.manifest.snapshot);
    const order = join(input.inbox, '.publication-order');
    if (kind === 'missing') await unlink(order);
    else await writeFile(order, 'not-an-order');
    await expect(preserveProof({ ...input, id: 'later' })).rejects.toMatchObject({
      category: kind === 'missing' ? 'missing-order' : 'invalid-order',
    });
    expect(await readFile(first.ready, 'utf8')).toBe(saved);
    expect(await readFile(first.manifest.snapshot)).toEqual(snapshot);
    expect(await readdir(input.inbox)).not.toContain('later.ready.json');
  },
);

it('leaves the distinct legacy publication directory and its diagnostic contents untouched', async () => {
  const input = await fixture();
  const legacy = join(input.inbox, '.publication-lock');
  await mkdir(legacy);
  await writeFile(join(legacy, 'owner'), 'ambiguous legacy owner');
  await expect(preserveProof(input)).rejects.toMatchObject({ category: 'legacy-publication-lock' });
  expect(await readFile(join(legacy, 'owner'), 'utf8')).toBe('ambiguous legacy owner');
  expect(await readdir(input.inbox)).toEqual(['.publication-lock']);
});

it.each(['EACCES', 'ENOSPC'])(
  'diagnoses local admission %s without labeling it contention or exposing error bodies',
  async (code) => {
    const input = await fixture();
    vi.mocked(fs.mkdir).mockRejectedValueOnce(
      Object.assign(Error('SENTINEL credential provider body !command'), { code }),
    );
    const failure = await preserveProof(input).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      phase: 'inbox-initialization',
      category: 'local-io-failure',
      code,
      artifactId: input.id,
    });
    expect(String(failure)).not.toMatch(/SENTINEL|credential|provider body|!command|contention/);
    expect(failure).not.toHaveProperty('cause');
  },
);

it('reports a lock-holder startup failure as local I/O, not live contention', async () => {
  const input = await fixture();
  await mkdir(join(input.inbox, '.publication-lock.sqlite'));
  await expect(preserveProof(input)).rejects.toMatchObject({
    phase: 'publication-lock',
    category: 'local-lock-failure',
  });
  expect(await readyNames(input)).toEqual([]);
});

it('keeps confirmed acceptance when lock release fails after the real ready sync', async () => {
  const input = await fixture();
  const events = observeIO();
  const send = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    value,
    ...rest
  ) {
    if (value === 'release') throw ioError('EIO');
    return send.call(this, value, ...rest);
  });
  const accepted = await preserveProof(input);
  expect(events.at(-1)).toBe(`sync:${physicalInbox(input.inbox)}`);
  expect(accepted.cleanupDiagnostic).toContain('accepted-cleanup-pending (EIO)');
  expect(await readFile(accepted.manifest.snapshot, 'utf8')).toBe(original);
  expect(await readFile(accepted.ready, 'utf8')).toContain('handoff-a');
  vi.restoreAllMocks();
  expect((await preserveProof({ ...input, id: 'next' })).manifest.admissionOrder).not.toBe(
    accepted.manifest.admissionOrder,
  );
});

it('keeps confirmed acceptance if closing the actually synced ready directory fails', async () => {
  const input = await fixture();
  const events = observeIO();
  let renamed = false;
  const observedOpen = vi.mocked(fs.open).getMockImplementation()!;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await observedOpen(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close();
      if (renamed && String(args[0]) === physicalInbox(input.inbox)) throw ioError('EIO');
    });
    return handle;
  });
  const observedRename = vi.mocked(fs.rename).getMockImplementation()!;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await observedRename(from, to);
    if (String(to).endsWith('.ready.json')) renamed = true;
  });
  const accepted = await preserveProof(input);
  expect(events.at(-1)).toBe(`sync:${physicalInbox(input.inbox)}`);
  expect(accepted.cleanupDiagnostic).toContain(
    'ready-directory-close: accepted-cleanup-pending (EIO)',
  );
  expect(await readFile(accepted.manifest.snapshot, 'utf8')).toBe(original);
  expect(await readFile(accepted.ready, 'utf8')).toContain('handoff-a');
});

it('retains the ambiguous snapshot and ready file when the actual final directory sync fails', async () => {
  const input = await fixture();
  let renamed = false;
  const events = observeIO((path) => renamed && path === physicalInbox(input.inbox));
  const renameWithObservation = vi.mocked(fs.rename).getMockImplementation()!;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await renameWithObservation(from, to);
    if (String(to).endsWith('.ready.json')) renamed = true;
  });
  await expect(preserveProof(input)).rejects.toMatchObject({
    phase: 'ready-directory-sync',
    category: 'acceptance-uncertain',
    code: 'EACCES',
  });
  expect(events.at(-1)).toContain('.ready.json');
  expect(await readFile((await loadReady(input)).snapshot, 'utf8')).toBe(original);
});

it.each(['unlink', 'sync'])(
  'returns a committed import with pending signal cleanup after actual %s failure',
  async (failure) => {
    const input = await fixture();
    const accepted = await preserveProof(input);
    const file = join(input.inbox, '..', 'capture.db');
    const owner = CaptureWorkerOwnership.claim(file);
    const store = new CheckpointStore(file);
    try {
      if (failure === 'unlink') vi.mocked(fs.unlink).mockRejectedValueOnce(ioError('EACCES'));
      else observeIO((path) => path === physicalInbox(input.inbox));
      const imported = await importReadyHandoff(store, owner, accepted.ready);
      expect(imported).toMatchObject({
        job: { state: 'queued', manifest: { id: input.id } },
        signalCleanupPending: true,
      });
      expect(imported.cleanupDiagnostic).toContain('committed-signal-cleanup-pending (EACCES)');
      expect(store.captureJob(input.id)?.manifest).toEqual(accepted.manifest);
      vi.mocked(fs.unlink).mockImplementation(realFs.unlink);
      vi.mocked(fs.open).mockImplementation(realFs.open);
      if (failure === 'unlink') {
        const retried = await importReadyHandoff(store, owner, accepted.ready);
        expect(retried).toMatchObject({ job: imported.job, signalCleanupPending: false });
        expect(await readyNames(input)).toEqual([]);
      }
    } finally {
      store.close();
      owner.release();
    }
  },
);

it.each([1, 2, 99])(
  'rejects unsupported v%s before ordinary import without changing its evidence',
  async (version) => {
    const input = await fixture();
    const accepted = await preserveProof(input);
    const unsupported = { ...accepted.manifest, version };
    await writeFile(accepted.ready, JSON.stringify(unsupported));
    const bytes = await readFile(accepted.ready, 'utf8');
    const file = join(input.inbox, '..', 'capture.db');
    const owner = CaptureWorkerOwnership.claim(file);
    const store = new CheckpointStore(file);
    const importer = vi.spyOn(store, 'importCaptureJob');
    try {
      await expect(importReadyHandoff(store, owner, accepted.ready)).rejects.toMatchObject({
        phase: 'ready-validation',
        category: 'unsupported-or-invalid-manifest',
        artifactId: input.id,
      });
      expect(importer).not.toHaveBeenCalled();
      expect(store.captureJob(input.id)).toBeUndefined();
      expect(await readFile(accepted.ready, 'utf8')).toBe(bytes);
      expect(await readFile(accepted.manifest.snapshot, 'utf8')).toBe(original);
    } finally {
      store.close();
      owner.release();
    }
  },
);

it('uses one physical inbox sequence across symlink publication and real-path recovery', async () => {
  const input = await fixture();
  const alias = join(input.inbox, '..', 'alias');
  await symlink(input.inbox, alias);
  const accepted = await preserveProof({ ...input, inbox: alias });
  expect(dirname(accepted.manifest.snapshot)).toBe(physicalInbox(input.inbox));
  expect(validateReadyManifest(accepted.manifest, alias)).toEqual(accepted.manifest);
  // Validation compares physical directories but never rewrites retained JSON.
  const aliasPayload = {
    ...accepted.manifest,
    snapshot: join(alias, `${input.id}.snapshot.jsonl`),
  };
  expect(validateReadyManifest(aliasPayload, input.inbox)).toEqual(aliasPayload);
  const file = join(input.inbox, '..', 'capture.db');
  const owner = CaptureWorkerOwnership.claim(file);
  const store = new CheckpointStore(file);
  try {
    await importReadyHandoff(store, owner, join(input.inbox, `${input.id}.ready.json`));
    const next = await preserveProof({ ...input, id: 'next' });
    const second = await importReadyHandoff(store, owner, join(alias, 'next.ready.json'));
    expect(BigInt(second.job.manifest.admissionOrder)).toBeGreaterThan(
      BigInt(accepted.manifest.admissionOrder),
    );
    expect(second.job.manifest).toEqual(next.manifest);
  } finally {
    store.close();
    owner.release();
  }
});

it('waits asynchronously for an independent healthy publisher and acknowledges both in durable order', async () => {
  const input = await fixture();
  const first = await publisherAt(input, 'snapshot-copy');
  await first.stopped;
  const second = await publisherAt({ ...input, id: 'second' }, 'returned');
  let secondStopped = false;
  void second.stopped.then(() => {
    secondStopped = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondStopped).toBe(false);
    // This is B's foreground thread, not this test process. Synchronous SQLite
    // waiting in the publishing thread would prevent these IPC heartbeats.
    expect(second.ticks).toBeGreaterThan(2);
    expect(await readyNames(input)).toEqual([]);
    first.child.send('resume');
    expect(await first.exited).toEqual({ code: 0, signal: null });
    await second.stopped;
    const a = JSON.parse(
      await readFile(join(input.inbox, `${input.id}.ready.json`), 'utf8'),
    ) as ProofManifest;
    const b = JSON.parse(
      await readFile(join(input.inbox, 'second.ready.json'), 'utf8'),
    ) as ProofManifest;
    expect(BigInt(b.admissionOrder)).toBe(BigInt(a.admissionOrder) + 1n);
    expect(await readFile(join(input.inbox, '.publication-order'), 'utf8')).toBe(b.admissionOrder);
    second.child.send('resume');
    expect(await second.exited).toEqual({ code: 0, signal: null });
  } finally {
    if (second.child.exitCode === null && second.child.signalCode === null)
      second.child.kill('SIGKILL');
  }
}, 12000);

it('serializes same-process physical aliases before opening another lock descriptor', async () => {
  const input = await fixture();
  const alias = join(input.inbox, '..', 'alias');
  await symlink(input.inbox, alias);
  let release!: () => void;
  let copied!: () => void;
  const copying = new Promise<void>((resolve) => {
    copied = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = preserveProof(input, {
    after: async (step) => {
      if (step === 'snapshot-copy') {
        copied();
        await held;
      }
    },
  });
  await copying;
  let completed = false;
  const second = preserveProof({ ...input, inbox: alias, id: 'second' }).then((value) => {
    completed = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(completed).toBe(false);
  const outsider = await publisherAt({ ...input, id: 'outsider' }, 'returned');
  let outsideDone = false;
  void outsider.stopped.then(() => {
    outsideDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(outsideDone).toBe(false);
  release();
  const a = await first;
  const b = await second;
  await outsider.stopped;
  expect(BigInt(b.manifest.admissionOrder)).toBeGreaterThan(BigInt(a.manifest.admissionOrder));
  expect(await readyNames(input)).toHaveLength(3);
  outsider.child.send('resume');
  expect(await outsider.exited).toEqual({ code: 0, signal: null });
}, 12000);

it('independently syncs ancestors while their creator is paused before its first actual sync', async () => {
  const input = await fixture();
  input.inbox = join(input.inbox, 'new-parent', 'new-inbox');
  const creator = await publisherAt(input, 'ancestors-created');
  await creator.stopped;
  const events = observeIO();
  const accepted = await preserveProof({ ...input, id: 'independent' });
  for (let directory = physicalInbox(input.inbox); ; directory = dirname(directory)) {
    expect(events).toContain(`sync:${directory}`);
    if (directory === dirname(directory)) break;
  }
  creator.child.kill('SIGKILL');
  expect(await creator.exited).toEqual({ code: null, signal: 'SIGKILL' });
  expect(await readFile(accepted.manifest.snapshot, 'utf8')).toBe(original);
}, 12000);

it('orders real asynchronous preservation, syncs, and one atomic ready manifest before acknowledgement', async () => {
  const input = await fixture();
  const events = observeIO();
  let release!: () => void;
  let copying!: () => void;
  const started = new Promise<void>((resolve) => (copying = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let acknowledged = false;
  const pending = preserveProof(input, {
    copy: async (source, destination, flags) => {
      copying();
      await blocked;
      await forceCopy(source, destination, flags);
    },
    after: async (step) => {
      if (step === 'manifest-rename') {
        // Readers can see ready before its directory flush. Bytes are already
        // durable; a producer must not acknowledge until the final sync returns.
        expect(acknowledged).toBe(false);
        expect(await readFile((await loadReady(input)).snapshot, 'utf8')).toBe(original);
      }
    },
  }).then((value) => {
    acknowledged = true;
    events.push('acknowledged');
    return value;
  });
  await started;
  expect(await readyNames(input)).toEqual([]);
  expect(acknowledged).toBe(false);
  release();
  const result = await pending;
  const inbox = physicalInbox(input.inbox);
  const snapshots = join(inbox, 'handoff-a.snapshot.jsonl');
  const order = join(inbox, '.publication-order');
  // Independently stated I/O protocol, not the production hook labels.
  const ancestors: string[] = [];
  for (let directory = inbox; ; directory = dirname(directory)) {
    ancestors.push(`sync:${directory}`);
    if (directory === dirname(directory)) break;
  }
  const orderSyncs = events.filter((event) =>
    /^sync:.*\/\.publication-order\.[a-f0-9-]{36}\.tmp$/.test(event),
  );
  expect(orderSyncs).toHaveLength(2);
  const initialScratch = orderSyncs[0]!.slice('sync:'.length);
  const admissionScratch = orderSyncs[1]!.slice('sync:'.length);
  expect(events).toEqual([
    ...ancestors,
    `sync:${initialScratch}`,
    `rename:${initialScratch}:${order}`,
    `sync:${inbox}`,
    `sync:${snapshots}`,
    `sync:${inbox}`,
    `sync:${admissionScratch}`,
    `rename:${admissionScratch}:${order}`,
    `sync:${inbox}`,
    `sync:${join(inbox, '.handoff-a.ready.tmp')}`,
    `rename:${join(inbox, '.handoff-a.ready.tmp')}:${join(inbox, 'handoff-a.ready.json')}`,
    `sync:${inbox}`,
    'acknowledged',
  ]);
  expect(result.copyMode).toBe('copy');
  expect(await readdir(input.inbox)).toEqual([
    '.publication-lock.sqlite',
    '.publication-order',
    'handoff-a.ready.json',
    'handoff-a.snapshot.jsonl',
  ]);
  expect((await stat(input.inbox)).mode & 0o777).toBe(0o700);
  for (const path of [
    result.ready,
    result.manifest.snapshot,
    join(input.inbox, '.publication-order'),
  ])
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.manifest).toMatchObject({
    version: 3,
    id: input.id,
    source: { ...input.source, bytes: Buffer.byteLength(original) },
    execution: input.execution,
  });
});

it('freezes originating metadata before asynchronous preservation starts', async () => {
  const input = await fixture();
  const expected = structuredClone(input);
  const result = await preserveProof(input, {
    copy: forceCopy,
    after: (step) => {
      if (step !== 'snapshot-copy') return;
      input.source.sessionId = 'destination';
      input.execution.runtime.model.id = 'later-model';
      input.execution.authorization.autoCapture = false as true;
    },
  });
  expect(result.manifest.source).toMatchObject(expected.source);
  expect(result.manifest.execution).toEqual(expected.execution);
});

it.each(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL'])(
  'falls back from unsupported clone (%s) to exclusive full copy',
  async (code) => {
    const input = await fixture();
    const flagsSeen: number[] = [];
    const result = await preserveProof(input, {
      copy: async (source, destination, flags = 0) => {
        flagsSeen.push(flags);
        if (flags & constants.COPYFILE_FICLONE_FORCE) throw ioError(code);
        await copyFile(source, destination, flags);
      },
    });
    expect(flagsSeen).toEqual([
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
      constants.COPYFILE_EXCL,
    ]);
    expect(result.copyMode).toBe('copy');
    expect(await readFile(result.manifest.snapshot, 'utf8')).toBe(original);
  },
);

it.each(['EIO', 'ENOSPC', 'EACCES', 'EEXIST'])(
  'does not hide clone failure %s by attempting another copy or publishing',
  async (code) => {
    const input = await fixture();
    let calls = 0;
    await expect(
      preserveProof(input, {
        copy: async () => {
          calls++;
          throw ioError(code);
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
    expect(await readyNames(input)).toEqual([]);
    expect(await readFile(input.source.file, 'utf8')).toBe(original);
  },
);

it.each(['EIO', 'ENOSPC', 'EACCES'])(
  'retains source and never publishes a partial fallback copy after %s',
  async (code) => {
    const input = await fixture();
    await expect(
      preserveProof(input, {
        copy: async (_source, destination, flags = 0) => {
          if (flags & constants.COPYFILE_FICLONE_FORCE) throw ioError('ENOTSUP');
          await writeFile(destination, original.slice(0, 20), { flag: 'wx' });
          throw ioError(code);
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(await readyNames(input)).toEqual([]);
    expect(await readFile(input.source.file, 'utf8')).toBe(original);
  },
);

it.each(['platform-clone-or-fallback', 'forced-full-copy'])(
  '%s retains independent bytes through later append, in-place rewrite, unlink and pathname reuse',
  async (mode) => {
    const input = await fixture();
    const result = await preserveProof(
      input,
      mode === 'forced-full-copy' ? { copy: forceCopy } : {},
    );
    const initial = await stat(input.source.file, { bigint: true });
    const saved = await stat(result.manifest.snapshot, { bigint: true });
    expect(saved.ino).not.toBe(initial.ino);
    await appendFile(input.source.file, 'later appended records\n');
    expect(await readFile(result.manifest.snapshot, 'utf8')).toBe(original);
    await writeFile(input.source.file, 'in-place migration rewrite\n');
    expect((await stat(input.source.file, { bigint: true })).ino).toBe(initial.ino);
    expect(await readFile(result.manifest.snapshot, 'utf8')).toBe(original);
    await unlink(input.source.file);
    expect(await readFile(result.manifest.snapshot, 'utf8')).toBe(original);
    await writeFile(input.source.file, 'different session at the same path\n');
    expect(await readFile(result.manifest.snapshot, 'utf8')).toBe(original);
  },
);

it.each(['append', 'rewrite', 'replace', 'unlink', 'short-copy'])(
  'refuses acknowledgement when source/copy changes during asynchronous preservation: %s',
  async (mutation) => {
    const input = await fixture();
    await expect(
      preserveProof(input, {
        copy: forceCopy,
        after: async (step) => {
          if (step !== 'snapshot-copy') return;
          if (mutation === 'append') await appendFile(input.source.file, 'later');
          if (mutation === 'rewrite')
            await writeFile(input.source.file, 'x'.repeat(Buffer.byteLength(original)));
          if (mutation === 'replace') {
            await rename(input.source.file, `${input.source.file}.old`);
            await writeFile(input.source.file, original);
          }
          if (mutation === 'unlink') await unlink(input.source.file);
          if (mutation === 'short-copy')
            await writeFile(join(input.inbox, `${input.id}.snapshot.jsonl`), 'short');
        },
      }),
    ).rejects.toThrow();
    expect(await readyNames(input)).toEqual([]);
  },
);

it('copies a 32 MiB source asynchronously without parsing, preserving every byte on full-copy fallback', async () => {
  const input = await fixture();
  const handle = await open(input.source.file, 'w');
  const block = Buffer.alloc(512 * 1024, 0xa5);
  try {
    for (let n = 0; n < 64; n++) await handle.writeFile(block);
  } finally {
    await handle.close();
  }
  const started = performance.now();
  const result = await preserveProof(input, { copy: forceCopy });
  const elapsedMs = performance.now() - started;
  expect(result.manifest.source.bytes).toBe(32 * 1024 * 1024);
  expect(await digest(result.manifest.snapshot)).toBe(await digest(input.source.file));
  console.info(
    JSON.stringify({ preservationProof: 'full-copy', bytes: 32 * 1024 * 1024, elapsedMs }),
  );
});

it.each(proofSteps)('never acknowledges an injected I/O failure before %s', async (failedStep) => {
  const input = await fixture();
  let acknowledged = false;
  await expect(
    preserveProof(input, {
      copy: forceCopy,
      before: (step) => {
        if (step === failedStep) throw ioError('EIO');
      },
    }).then(() => (acknowledged = true)),
  ).rejects.toMatchObject({ code: 'EIO' });
  expect(acknowledged).toBe(false);
  expect(await readFile(input.source.file, 'utf8')).toBe(original);
  if (failedStep === 'ready-directory-sync') {
    // Rename succeeded, acknowledgement did not. Leave both artifacts intact.
    expect(await readFile((await loadReady(input)).snapshot, 'utf8')).toBe(original);
  } else {
    expect(await readyNames(input)).toEqual([]);
  }
});

it('does not overwrite or remove an earlier accepted handoff on duplicate admission', async () => {
  const input = await fixture();
  const first = await preserveProof(input, { copy: forceCopy });
  const manifestBytes = await readFile(first.ready, 'utf8');
  await writeFile(input.source.file, 'newer unsuccessful evidence');
  await expect(preserveProof(input, { copy: forceCopy })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(first.ready, 'utf8')).toBe(manifestBytes);
  expect(await readFile(first.manifest.snapshot, 'utf8')).toBe(original);
});

async function publisherAt(
  input: ProofInput,
  stopAt: ProofStep | 'returned' | 'ancestors-created',
) {
  const home = join(input.inbox, '..', 'isolated-home');
  const locations = ['config', 'data', 'state', 'cache', 'agent', 'tasks', 'tmp'];
  await Promise.all(locations.map((name) => mkdir(join(home, name), { recursive: true })));
  await writeFile(join(home, 'agent', 'settings.json'), '{}');
  await writeFile(join(home, 'taskrc'), '');
  const child = spawn(
    process.execPath,
    [
      '--loader',
      fileURLToPath(new URL('./fixtures/typescript-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/capture-preservation-proof-child.mjs', import.meta.url)),
      JSON.stringify(input),
      stopAt,
    ],
    {
      cwd: home,
      // Deliberate allowlist: no provider keys, NODE_OPTIONS, host HOME, settings,
      // XDG paths, Taskwarrior data or command-backed credential configuration.
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        XDG_CACHE_HOME: join(home, 'cache'),
        PI_CODING_AGENT_DIR: join(home, 'agent'),
        TASKRC: join(home, 'taskrc'),
        TASKDATA: join(home, 'tasks'),
        TMPDIR: join(home, 'tmp'),
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  let ticks = 0;
  child.on('message', (message) => {
    if ((message as { tick?: boolean }).tick) ticks++;
  });
  const stopped = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Child timed out at ${stopAt}: ${stderr}`)), 8000);
    const onMessage = (message: unknown) => {
      if ((message as { tick?: boolean }).tick) return;
      child.off('message', onMessage);
      clearTimeout(timer);
      if ((message as { step: string }).step === stopAt) resolve();
      else reject(Error(`Unexpected crash checkpoint: ${JSON.stringify(message)}`));
    };
    child.on('message', onMessage);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(Error(`Child exited before ${stopAt}: ${code}/${signal}: ${stderr}`));
    });
  });
  return {
    child,
    stopped,
    exited,
    get ticks() {
      return ticks;
    },
  };
}

async function killedAt(input: ProofInput, stopAt: ProofStep | 'returned') {
  const publisher = await publisherAt(input, stopAt);
  await publisher.stopped;
  publisher.child.kill('SIGKILL');
  expect(await publisher.exited).toEqual({ code: null, signal: 'SIGKILL' });
}

it.each([...proofSteps, 'returned'] as const)(
  'retains evidence across real SIGKILL after %s, with no partial ready manifest',
  async (stopAt) => {
    const input = await fixture();
    await killedAt(input, stopAt);
    expect(await readFile(input.source.file, 'utf8')).toBe(original);
    const published = ['manifest-rename', 'ready-directory-sync', 'returned'].includes(stopAt);
    if (published) {
      const manifest = await loadReady(input);
      expect(manifest.source).toMatchObject(input.source);
      await unlink(input.source.file);
      expect(await readFile(manifest.snapshot, 'utf8')).toBe(original);
      await writeFile(input.source.file, original);
    } else {
      expect(await readyNames(input)).toEqual([]);
    }
    if (stopAt !== 'source-stat')
      expect(await readFile(join(input.inbox, `${input.id}.snapshot.jsonl`), 'utf8')).toBe(
        original,
      );
    const priorOrder = await readFile(join(input.inbox, '.publication-order'), 'utf8');
    const retained = published
      ? await readFile(join(input.inbox, `${input.id}.ready.json`), 'utf8')
      : null;
    const next = await preserveProof({ ...input, id: 'after-crash' });
    expect(BigInt(next.manifest.admissionOrder)).toBeGreaterThan(BigInt(priorOrder));
    expect(await stat(join(input.inbox, '.publication-lock.sqlite'))).toBeDefined();
    if (retained)
      expect(await readFile(join(input.inbox, `${input.id}.ready.json`), 'utf8')).toBe(retained);
  },
  12_000,
);
