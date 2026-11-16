import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { prepareReview, readSession } from '../extensions/remembrancer/evidence.js';
import {
  preserveHandoff as preserveProof,
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
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  children.clear();
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
  // Inbox provisioning is outside admission. Persist its directory entry first.
  for (const path of [dir, tmpdir()]) {
    const handle = await open(path, 'r');
    await handle.sync();
    await handle.close();
  }
  return {
    id: 'handoff-a',
    inbox,
    source: { file, sessionId: 'outgoing' },
    execution: {
      cwd: '/origin-project',
      agentDir: '/origin-agent',
      trustBasis: 'explicit-project-trust',
      authorization: { autoCapture: true, disabled: false },
      model: { provider: 'offline-fixture', id: 'outgoing-model' },
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
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

it('orders real asynchronous preservation, syncs, and one atomic ready manifest before acknowledgement', async () => {
  const input = await fixture();
  const events: string[] = [];
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
      events.push(step);
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
  expect(events).toEqual([...proofSteps, 'acknowledged']);
  expect(result.copyMode).toBe('copy');
  expect(await readdir(input.inbox)).toEqual(['handoff-a.ready.json', 'handoff-a.snapshot.jsonl']);
  expect((await stat(input.inbox)).mode & 0o777).toBe(0o700);
  for (const path of [result.ready, result.manifest.snapshot])
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.manifest).toMatchObject({
    version: 1,
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
      input.execution.model.id = 'later-model';
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

it('demonstrates why an extent/path or hard link is not preservation', async () => {
  const input = await fixture();
  const hardlink = join(input.inbox, 'unsafe-hardlink');
  await link(input.source.file, hardlink);
  await writeFile(input.source.file, 'rewritten');
  expect(await readFile(hardlink, 'utf8')).not.toBe(original);
  expect((await readFile(input.source.file)).subarray(0, Buffer.byteLength(original))).not.toEqual(
    Buffer.from(original),
  );
});

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

it('keeps source provenance, both saved leaves, and edit identities independent of the artifact path', async () => {
  const input = await fixture();
  const { manifest } = await preserveProof(input, { copy: forceCopy });
  await unlink(input.source.file);
  const tree = readSession(manifest.snapshot);
  // Existing readSession uses its physical pathname in tips. A production
  // handoff adapter must explicitly rebind tips to the original source identity.
  expect(tree.tips.every((tip) => tip.file === manifest.snapshot)).toBe(true);
  tree.tips = tree.tips.map((tip) => ({ ...tip, file: manifest.source.file }));
  const review = prepareReview([input.source], [], undefined, [{ source: input.source, tree }]);
  expect(review.incomplete).toBe(false);
  expect(review.tips.map((tip) => tip.entryId)).toEqual(['edit', 'right']);
  expect(
    review.evidence.map((item) => [item.branchId, item.entryId, item.editId, item.text]),
  ).toEqual([
    ['edit', 'root', 'edit', 'Edited commitment'],
    ['edit', 'left', null, 'Left branch'],
    ['right', 'root', null, 'Keep this commitment: café 🌱'],
    ['right', 'right', null, 'Sibling branch'],
  ]);
  for (const reference of [...review.evidence, ...review.checkpoints]) {
    expect(reference.file).toBe(input.source.file);
    expect(reference.sessionId).toBe(input.source.sessionId);
  }
  const wrong = { ...input.source, sessionId: 'destination-session' };
  const rejected = prepareReview([wrong], [], undefined, [{ source: wrong, tree }]);
  expect(rejected.incomplete).toBe(true);
  expect(rejected.evidence).toEqual([]);
  expect(rejected.checkpoints).toEqual([]);
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

async function killedAt(input: ProofInput, stopAt: ProofStep | 'returned') {
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
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Child timed out at ${stopAt}: ${stderr}`)), 8000);
    child.once('message', (message) => {
      clearTimeout(timer);
      if ((message as { step: string }).step === stopAt) resolve();
      else reject(Error(`Unexpected crash checkpoint: ${JSON.stringify(message)}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(Error(`Child exited before ${stopAt}: ${code}/${signal}: ${stderr}`));
    });
  });
  child.kill('SIGKILL');
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
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
    } else {
      expect(await readyNames(input)).toEqual([]);
    }
    if (stopAt !== 'source-stat')
      expect(await readFile(join(input.inbox, `${input.id}.snapshot.jsonl`), 'utf8')).toBe(
        original,
      );
  },
  12_000,
);
