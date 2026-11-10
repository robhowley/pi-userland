import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { FinishPlan } from '../extensions/remembrancer/checkpoints.js';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';

function finish(
  store: CheckpointStore,
  input: FinishPlan | readonly { file: string; sessionId: string; entryId: string }[],
) {
  const token = store.claimReview();
  store.freezeReview(
    token,
    Array.isArray(input) ? { checkpoints: input } : (input as FinishPlan),
    [],
    false,
  );
  try {
    return store.finish(token, []);
  } catch (error) {
    store.releaseReview(token);
    throw error;
  }
}

const a = { file: '/custom/a.jsonl', sessionId: 'a', entryId: 'first' };

it('persists enrollment separately from finished boundaries and updates source paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-store-'));
  const path = join(dir, 'state', 'index.sqlite');
  let store = new CheckpointStore(path);
  try {
    store.enroll(a.sessionId, a.file);
    expect(store.reviewed()).toEqual([]);
    finish(store, [a]);
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
    expect(store.proposals()).toEqual([]);
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
    finish(store, {
      sourceDefaults: [{ sessionId: a.sessionId, since: first }],
      checkpoints: [{ ...a, since: first }],
    });
    expect(store.sources()).toEqual([{ sessionId: 'a', file: a.file, seedSince: first }]);
    expect(store.reviewed()).toEqual([{ ...a, since: first }]);

    store.enroll(a.sessionId, '/moved/a.jsonl');
    expect(store.sources()).toEqual([{ sessionId: 'a', file: '/moved/a.jsonl', seedSince: first }]);
    finish(store, {
      sourceDefaults: [{ sessionId: a.sessionId, since: earlier }],
      checkpoints: [{ ...a, since: earlier }],
    });
    finish(store, {
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
      finish(store, {
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
    expect(() => finish(store, [a, { ...a, entryId: '' }])).toThrow();
    expect(store.reviewed()).toEqual([]);
    expect(() => finish(store, [a, { ...a, sessionId: 'unknown' }])).toThrow();
    expect(store.reviewed()).toEqual([]);
  } finally {
    store.close();
  }
});

it('uses a finite lease without retaining a writer lock, rejects stale owners', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-lease-'));
  const path = join(dir, 'index.sqlite');
  let now = 1000;
  const owner = new CheckpointStore(path, () => now);
  const peer = new CheckpointStore(path, () => now);
  try {
    const old = owner.claimReview('manual', 2000);
    owner.freezeReview(old, { checkpoints: [a] }, [], false);
    expect(() => peer.claimReview()).toThrow(/already open/);
    peer.enroll(a.sessionId, a.file);
    const probe = new DatabaseSync(path);
    probe.exec('BEGIN IMMEDIATE; ROLLBACK');
    probe.close();
    now = 2000;
    expect(() => owner.renewReview(old)).toThrow(/expired/);
    const next = peer.claimReview();
    expect(() => owner.finish(old, [])).toThrow(/ownership/);
    expect(() => owner.renewReview(old)).toThrow();
    owner.releaseReview(old);
    expect(() => owner.finish(old, [])).toThrow();
    peer.assertReview(next);
    peer.freezeReview(next, { checkpoints: [a] }, [], false);
    expect(peer.finish(next, [])).toEqual([]);
    expect(peer.reviewed()).toEqual([{ ...a, since: null }]);
    expect(() => peer.finish(next, [])).toThrow();
    const automatic = peer.claimReview('automatic', 3000);
    expect(() => peer.renewReview(automatic)).toThrow(/non-manual/);
  } finally {
    owner.close();
    peer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
