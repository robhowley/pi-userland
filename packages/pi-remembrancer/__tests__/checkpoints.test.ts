import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(store.sources()).toEqual([{ sessionId: 'a', file: a.file }]);
    expect(store.reviewed()).toEqual([a]);
    store.enroll('a', '/moved/a.jsonl');
    expect(store.reviewed()).toEqual([{ ...a, file: '/moved/a.jsonl' }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
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
