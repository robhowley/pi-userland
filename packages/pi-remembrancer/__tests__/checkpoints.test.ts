import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import type {
  Proposal,
  ProposalSource,
  ProposalState,
} from '../extensions/remembrancer/proposals.js';

const a = { file: '/custom/a.jsonl', sessionId: 'a', entryId: 'first' };

const legacySource: ProposalSource = {
  file: '/missing/transcript.jsonl',
  sessionId: 'a',
  branchId: 'branch',
  entryId: 'entry',
  editId: null,
  offset: 4,
  quote: 'A promise',
  locator: 'a/branch/entry',
  role: 'user',
  timestamp: '2026-01-01',
};
function legacyProposal(id: string, state: ProposalState): Proposal {
  const change = {
    operation: 'add' as const,
    fields: { description: 'Current promise' },
    annotations: ['Keep this'],
  };
  const snapshot = {
    uuid: '00000000-0000-0000-0000-000000000001',
    status: 'pending' as const,
    fields: { description: 'Current promise' },
    annotations: [],
  };
  const active = state !== 'pending' && state !== 'dismissed';
  return {
    id,
    revision: 7,
    state,
    change,
    expected: null,
    question: 'Current question',
    explanation: 'Current explanation',
    draft: {
      change: { ...change, fields: { description: 'Edited promise' } },
      expected: null,
      question: 'Edited question',
    },
    sources: [legacySource],
    claim: active ? 'preserved-claim' : null,
    ...(active ? { applicationBefore: snapshot } : {}),
    result:
      state === 'pending' || state === 'dismissed' || state === 'applying'
        ? null
        : state === 'uncertain'
          ? { state, verified: snapshot, error: 'Unknown write', actual: { exact: ['write', 42] } }
          : { state, verified: snapshot, error: null, actual: { exact: ['write', 42] } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };
}

it('repairs only changed legacy proposals once in every state, preserving all other current fields and tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-current-only-'));
  const path = join(dir, 'index.sqlite');
  let store = new CheckpointStore(path);
  store.finish({ sources: [{ ...a, seedSince: '2026-01-01' }], checkpoints: [a] });
  store.close();
  const sql = new DatabaseSync(path);
  const rows: { value: Proposal; body: string; changed: boolean }[] = [];
  const states: ProposalState[] = [
    'pending',
    'dismissed',
    'applying',
    'applied',
    'already_satisfied',
    'uncertain',
  ];
  for (const state of states) {
    for (const repair of ['none', 'history', 'duplicates', 'both']) {
      const value = {
        ...legacyProposal(`${state}-${repair}`, state),
        customCurrentField: { preserve: true },
        ...(repair === 'history' || repair === 'both'
          ? { history: [{ obsolete: 'large snapshot' }] }
          : {}),
      };
      if (repair === 'duplicates' || repair === 'both')
        value.sources = [
          legacySource,
          { ...legacySource, file: '/new-path', locator: 'new-metadata' },
        ];
      const body = JSON.stringify(value, null, 2);
      sql
        .prepare('INSERT INTO proposals VALUES (?, ?, ?, ?)')
        .run(value.id, value.revision, state, body);
      rows.push({ value, body, changed: repair !== 'none' });
    }
  }
  sql.exec(`CREATE TABLE unrelated_tasks (body TEXT); INSERT INTO unrelated_tasks VALUES ('untouched');
    INSERT INTO capture_jobs VALUES ('stopped', 'a', '/retained/snapshot', '2026-01-01', '0001',
      '{"version":3,"attempts":4,"attemptLimit":4}', 'failed', 0, 'exhausted');
    UPDATE review_context SET generation = 100, notice_generation = 200;
    PRAGMA user_version = 0;`);
  const untouched = () =>
    ['sources', 'reviewed_boundaries', 'capture_jobs', 'unrelated_tasks'].map((table) =>
      sql.prepare(`SELECT * FROM ${table}`).all(),
    );
  const before = untouched();
  const changed = rows.filter((row) => row.changed).length;
  try {
    store = new CheckpointStore(path);
    for (const row of rows) {
      const current = store.proposal(row.value.id)!;
      const expected: Proposal & { history?: unknown } = { ...row.value };
      delete expected.history;
      expect(current).toEqual({
        ...expected,
        sources: [legacySource],
        revision: row.value.revision + Number(row.changed),
      });
      expect(
        sql.prepare('SELECT revision FROM proposals WHERE id = ?').get(current.id)!['revision'],
      ).toBe(current.revision);
      if (!row.changed)
        expect(
          sql.prepare('SELECT body FROM proposals WHERE id = ?').get(current.id)!['body'],
        ).toBe(row.body);
      expect(current).not.toHaveProperty('history');
    }
    expect(untouched()).toEqual(before);
    expect(store.contextGeneration()).toBe(100 + changed);
    expect(store.proposalNotice()).toEqual({ generation: 200 + changed, pending: 4 });
    expect(sql.prepare('PRAGMA user_version').get()!['user_version']).toBe(1);
    const repaired = sql.prepare('SELECT * FROM proposals ORDER BY rowid').all();
    store.close();
    store = new CheckpointStore(path);
    expect(sql.prepare('SELECT * FROM proposals ORDER BY rowid').all()).toEqual(repaired);
    expect(store.contextGeneration()).toBe(100 + changed);
    expect(store.proposalNotice()).toEqual({ generation: 200 + changed, pending: 4 });
    expect(untouched()).toEqual(before);
    // Recreated triggers continue to invalidate previews and prepared captures.
    const clean = store.proposal('pending-none')!;
    store.dismissProposal(clean.id, clean.revision);
    expect(store.contextGeneration()).toBe(101 + changed);
    expect(store.proposalNotice()).toEqual({ generation: 201 + changed, pending: 3 });
  } finally {
    store.close();
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rolls back repairs, generations, trigger replacement and migration marker on failure, then reopens safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-repair-rollback-'));
  const path = join(dir, 'index.sqlite');
  const store = new CheckpointStore(path);
  store.close();
  const sql = new DatabaseSync(path);
  for (const id of ['first', 'second']) {
    const value = {
      ...legacyProposal(id, 'pending'),
      history: [],
      sources: [legacySource, legacySource],
    };
    sql
      .prepare('INSERT INTO proposals VALUES (?, ?, ?, ?)')
      .run(id, value.revision, value.state, JSON.stringify(value));
  }
  sql.exec(`PRAGMA user_version = 0;
    DROP TRIGGER context_proposals_UPDATE;
    CREATE TRIGGER context_proposals_UPDATE AFTER UPDATE ON proposals BEGIN
      UPDATE review_context SET generation = generation + 50 WHERE singleton = 1;
    END;
    CREATE TRIGGER fail_repair BEFORE UPDATE ON proposals WHEN NEW.id = 'second' BEGIN
      SELECT RAISE(ABORT, 'injected repair failure');
    END;`);
  const before = sql.prepare('SELECT * FROM proposals ORDER BY rowid').all();
  const context = sql.prepare('SELECT * FROM review_context').all();
  const triggers = () =>
    sql.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
  const oldTriggers = triggers();
  try {
    expect(() => new CheckpointStore(path)).toThrow('injected repair failure');
    expect(sql.prepare('SELECT * FROM proposals ORDER BY rowid').all()).toEqual(before);
    expect(sql.prepare('SELECT * FROM review_context').all()).toEqual(context);
    expect(sql.prepare('PRAGMA user_version').get()!['user_version']).toBe(0);
    expect(triggers()).toEqual(oldTriggers);
    sql.exec('DROP TRIGGER fail_repair');
    const repaired = new CheckpointStore(path);
    expect(repaired.proposals().map((value) => value.revision)).toEqual([8, 8]);
    expect(repaired.contextGeneration()).toBe(Number(context[0]!['generation']) + 2);
    expect(sql.prepare('PRAGMA user_version').get()!['user_version']).toBe(1);
    const finalRows = sql.prepare('SELECT * FROM proposals ORDER BY rowid').all();
    repaired.close();
    const reopened = new CheckpointStore(path);
    expect(sql.prepare('SELECT * FROM proposals ORDER BY rowid').all()).toEqual(finalRows);
    reopened.close();
  } finally {
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('persists enrollment separately from finished boundaries and updates source paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-store-'));
  const path = join(dir, 'state', 'index.sqlite');
  let store = new CheckpointStore(path);
  try {
    store.enroll(a.sessionId, a.file);
    expect(store.reviewed()).toEqual([]);
    store.finish([a]);
    store.close();
    chmodSync(path, 0o644);
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

it('replaces persisted enrollment triggers without resetting rows or generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-triggers-'));
  const path = join(dir, 'index.sqlite');
  let store = new CheckpointStore(path);
  store.enroll('a', a.file);
  store.close();
  const old = new DatabaseSync(path);
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    old.exec(`DROP TRIGGER context_sources_${operation};
      CREATE TRIGGER context_sources_${operation} AFTER ${operation} ON sources BEGIN
        UPDATE review_context SET generation = generation + 1 WHERE singleton = 1;
      END`);
  }
  old.exec('UPDATE review_context SET generation = 42 WHERE singleton = 1');
  old.close();
  store = new CheckpointStore(path);
  try {
    expect(store.contextGeneration()).toBe(42);
    expect(store.sources()).toEqual([{ sessionId: 'a', file: a.file, seedSince: null }]);
    store.enroll('a', a.file);
    store.enroll('a', '/moved/a.jsonl');
    store.enroll('unrelated', '/elsewhere.jsonl');
    expect(store.contextGeneration()).toBe(42);
    store.finish({ sourceDefaults: [{ sessionId: 'a', since: '2026-01-01' }] });
    expect(store.contextGeneration()).toBe(43);
    store.claimReview();
    store.releaseReview();
    expect(store.contextGeneration()).toBe(44);
    store.finish([{ ...a, file: '/moved/a.jsonl' }]);
    expect(store.contextGeneration()).toBe(45);
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
    expect(statSync(path + '.lock').mode & 0o777).toBe(0o600);
    chmodSync(path + '.lock', 0o644);
    expect(() => peer.claimReview()).toThrow(/already open/);
    expect(statSync(path + '.lock').mode & 0o777).toBe(0o600);
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
