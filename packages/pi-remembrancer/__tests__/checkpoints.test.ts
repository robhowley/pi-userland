import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';

const a = { file: '/custom/a.jsonl', sessionId: 'a', entryId: 'first' };

it('persists enrollment separately from finished boundaries and updates source paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-store-'));
  const path = join(dir, 'state', 'index.sqlite');
  let store = new CheckpointStore(path);
  try {
    store.enroll(a.sessionId, a.file);
    expect(store.reviewed()).toEqual([]);
    store.finish([a]);
    store.close();
    store = new CheckpointStore(path);
    expect(store.sources()).toEqual([{ sessionId: 'a', file: a.file, seedSince: null }]);
    expect(store.reviewed()).toEqual([{ ...a, since: null }]);
    store.enroll('a', '/moved/a.jsonl');
    expect(store.reviewed()).toEqual([{ ...a, file: '/moved/a.jsonl', since: null }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('migrates legacy rows to unrestricted checkpoints and keeps the migration idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-migration-'));
  const path = join(dir, 'index.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE sources (session_id TEXT PRIMARY KEY, session_file TEXT NOT NULL);
    CREATE TABLE reviewed_boundaries (
      session_id TEXT NOT NULL,
      tip_id TEXT NOT NULL CHECK(tip_id <> ''),
      PRIMARY KEY (session_id, tip_id)
    );
  `);
  legacy.prepare('INSERT INTO sources VALUES (?, ?)').run('a', a.file);
  legacy.prepare('INSERT INTO reviewed_boundaries VALUES (?, ?)').run('a', a.entryId);
  legacy.close();

  let store = new CheckpointStore(path);
  try {
    expect(store.sources()).toEqual([{ sessionId: 'a', file: a.file, seedSince: null }]);
    expect(store.reviewed()).toEqual([{ ...a, since: null }]);
    store.close();
    store = new CheckpointStore(path);
    expect(store.reviewed()).toEqual([{ ...a, since: null }]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('persists earlier checkpoint and session-default dates atomically and idempotently', () => {
  const store = new CheckpointStore(':memory:');
  const first = '2026-01-16T00:00:00.000Z';
  const earlier = '2026-01-01T00:00:00.000Z';
  try {
    store.enroll(a.sessionId, a.file);
    store.finish({
      sourceDefaults: [{ sessionId: a.sessionId, since: first }],
      checkpoints: [{ ...a, since: first }],
    });
    expect(store.sources()).toEqual([{ sessionId: 'a', file: a.file, seedSince: first }]);
    expect(store.reviewed()).toEqual([{ ...a, since: first }]);

    store.enroll(a.sessionId, '/moved/a.jsonl');
    expect(store.sources()).toEqual([{ sessionId: 'a', file: '/moved/a.jsonl', seedSince: first }]);
    store.finish({
      sourceDefaults: [{ sessionId: a.sessionId, since: earlier }],
      checkpoints: [{ ...a, since: earlier }],
    });
    store.finish({
      sourceDefaults: [{ sessionId: a.sessionId, since: earlier }],
      checkpoints: [{ ...a, since: earlier }],
    });
    expect(store.sources()).toEqual([
      { sessionId: 'a', file: '/moved/a.jsonl', seedSince: earlier },
    ]);
    expect(store.reviewed()).toEqual([{ ...a, file: '/moved/a.jsonl', since: earlier }]);
  } finally {
    store.close();
  }
});

it('rolls back staged enrollment, defaults, and checkpoints together', () => {
  const store = new CheckpointStore(':memory:');
  try {
    expect(() =>
      store.finish({
        sources: [{ file: '/custom/new.jsonl', sessionId: 'new', seedSince: '2026-01-01' }],
        sourceDefaults: [{ sessionId: 'missing', since: '2026-01-01' }],
        checkpoints: [
          { file: '/custom/new.jsonl', sessionId: 'new', entryId: 'leaf', since: null },
        ],
      }),
    ).toThrow();
    expect(store.sources()).toEqual([]);
    expect(store.reviewed()).toEqual([]);
  } finally {
    store.close();
  }
});

it('rolls back the whole finish on an invalid boundary', () => {
  const store = new CheckpointStore(':memory:');
  try {
    store.enroll(a.sessionId, a.file);
    expect(() => store.finish([a, { ...a, entryId: '' }])).toThrow();
    expect(store.reviewed()).toEqual([]);
    expect(() => store.finish([a, { ...a, sessionId: 'unknown' }])).toThrow();
    expect(store.reviewed()).toEqual([]);
  } finally {
    store.close();
  }
});

it.each(['release', 'SIGKILL'] as const)(
  'excludes a manual claimant while a separate process owns the capture-compatible lock, then permits it after %s',
  async (ending) => {
    const dir = mkdtempSync(join(tmpdir(), 'remembrancer-process-owner-'));
    const path = join(dir, 'index.sqlite');
    const peer = new CheckpointStore(path);
    const owner = fork(
      fileURLToPath(new URL('./fixtures/review-lock-child.mjs', import.meta.url)),
      [path, 'hold'],
      {
        execArgv: ['--experimental-strip-types'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let stderr = '';
    owner.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(owner, 'exit');
    try {
      const [message] = await Promise.race([
        once(owner, 'message'),
        exited.then(() => {
          throw new Error(`Lock owner exited before readiness: ${stderr}`);
        }),
      ]);
      expect(message, stderr).toBe('owned');
      expect(() => peer.claimReview()).toThrow('already open in another Pi process');
      peer.enroll(a.sessionId, a.file);
      expect(peer.sources()).toEqual([{ sessionId: a.sessionId, file: a.file, seedSince: null }]);
      expect(peer.reviewed()).toEqual([]);
      // Enrollment on the data database must not drop ownership of the .lock database.
      expect(() => peer.claimReview()).toThrow('already open in another Pi process');
      if (ending === 'release') owner.send('release');
      else owner.kill(ending);
      expect(await exited, stderr).toEqual(ending === 'release' ? [0, null] : [null, 'SIGKILL']);
      peer.claimReview();
      peer.finish([a]);
      peer.releaseReview();
      expect(peer.reviewed()).toEqual([{ ...a, since: null }]);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await exited;
      peer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('excludes other processes while allowing enrollment, and releases on close', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-lock-'));
  const path = join(dir, 'index.sqlite');
  const owner = new CheckpointStore(path);
  const peer = new CheckpointStore(path);
  try {
    owner.claimReview();
    expect(() => peer.claimReview()).toThrow(/already open/);
    peer.enroll(a.sessionId, a.file);
    expect(owner.sources()).toHaveLength(1);
    const claim = `import { DatabaseSync } from 'node:sqlite';
      const probe = new DatabaseSync(process.argv[1]);
      try { probe.exec('BEGIN IMMEDIATE'); console.log('acquired'); }
      catch (error) { if (error?.errcode !== 5) throw error; console.log('busy'); }
      finally { probe.close(); }`;
    const probe = () => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', claim, `${path}.lock`],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    expect(probe()).toBe('busy');
    owner.releaseReview();
    expect(probe()).toBe('acquired');
    peer.claimReview();
    peer.close();
    expect(probe()).toBe('acquired');
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
