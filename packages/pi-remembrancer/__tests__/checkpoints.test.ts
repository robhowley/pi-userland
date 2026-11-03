import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';

const a = { file: '/custom/a.jsonl', sessionId: 'a', entryId: 'first' };
const late = { ...a, entryId: 'later' };

it('enrollments survive crashes; old review batches leave later tips and forks pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-store-'));
  const path = join(dir, 'state', 'remembrancer.sqlite');
  const first = new CheckpointStore(path);
  const second = new CheckpointStore(path);
  try {
    first.enroll(a.sessionId, a.file);
    expect(second.sources()[0]?.file).toBe(a.file);
    expect(second.pending()).toEqual([]);

    first.capture(a);
    first.claimReview();
    expect(() => second.claimReview()).toThrow(/already open/);
    const batch = first.pending();
    second.capture(late);
    second.capture({ ...a, sessionId: 'fork' });
    first.finish(batch);
    first.releaseReview();
    second.claimReview();
    second.releaseReview();
    second.finish(batch);
    second.capture(a);

    expect(second.reviewed().map((tip) => tip.entryId)).toEqual(['first']);
    expect(first.pending().map((tip) => tip.sessionId)).toEqual(['a', 'fork']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('an unknown tip rolls back even previously matched rows in the same batch', () => {
  const store = new CheckpointStore(':memory:');
  try {
    store.capture(a);
    expect(() => store.finish([a, late])).toThrow(/unknown checkpoint/);
    expect(store.pending()).toHaveLength(1);
    expect(store.reviewed()).toHaveLength(0);
  } finally {
    store.close();
  }
});

it('a failed claim from another in-process instance retains the OS lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-lock-'));
  const path = join(dir, 'index.sqlite');
  const owner = new CheckpointStore(path);
  const peer = new CheckpointStore(path);
  try {
    owner.claimReview();
    expect(() => peer.claimReview()).toThrow(/already open/);

    const claim = `import { DatabaseSync } from 'node:sqlite';
      const probe = new DatabaseSync(process.argv[1]);
      try { probe.exec('BEGIN IMMEDIATE'); console.log('acquired'); }
      catch (error) { if (error?.code !== 'ERR_SQLITE_BUSY' && error?.errcode !== 5) throw error; console.log('busy'); }
      finally { probe.close(); }`;
    const probe = () => {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', claim, `${path}.lock`],
        {
          encoding: 'utf8',
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };

    expect(probe()).toBe('busy');
    owner.releaseReview();
    expect(probe()).toBe('acquired');
  } finally {
    owner.close();
    peer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('a completed scan survives re-enrollment and applies only to its original source', () => {
  const store = new CheckpointStore(':memory:');
  try {
    store.enroll(a.sessionId, a.file);
    expect(store.sources()[0]?.signature).toBeNull();
    store.capture(a);
    store.noteScan(a.sessionId, '1000:42', a.file);
    store.enroll(a.sessionId, a.file);
    expect(store.sources()[0]?.signature).toBe('1000:42');
    store.noteScan(a.sessionId, '2000:84');
    expect(store.sources()[0]?.signature).toBe('2000:84');
    store.enroll(a.sessionId, '/moved/a.jsonl');
    store.noteScan(a.sessionId, '3000:126', a.file);
    expect(store.sources()[0]?.signature).toBeNull();
    expect(store.pending()).toHaveLength(1);
    expect(store.reviewed()).toEqual([]);
    expect(store.pending()[0]?.file).toBe('/moved/a.jsonl');
    store.finish([a]);
    expect(store.reviewed()[0]?.file).toBe('/moved/a.jsonl');
  } finally {
    store.close();
  }
});

it('rejects checkpoints without entry IDs before touching the database', () => {
  const store = new CheckpointStore(':memory:');
  try {
    expect(() => store.capture({ ...a, entryId: '' })).toThrow(/entry ID is required/);
    expect(store.pending()).toEqual([]);
  } finally {
    store.close();
  }
});
