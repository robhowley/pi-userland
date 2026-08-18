import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RECONNECT_GRACE_MS,
  aggregateOwners,
  classifyOwner,
  createAtomicLedgerStore,
  createCoordinatorCore,
  decodeAckLine,
  decodeWireMessage,
  parseRuntimeArgs,
  probePidStart,
} from '../extensions/cmux-junction/coordinator.mjs';

const target = { socketPath: '/tmp/cmux fixture.sock', workspaceId: 'workspace-fixture' };
const tempDirectories: string[] = [];

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'pi-junction.lifecycle.v1',
    kind: 'snapshot',
    workspaceId: target.workspaceId,
    surfaceId: 'surface-a',
    sessionId: 'session-a',
    runtimeId: 'runtime-a',
    pid: 4321,
    processStartedAt: 1_700_000_000_000,
    connectionId: 'connection-a',
    ownerGeneration: null,
    revision: 0,
    sentAt: 1_700_000_001_000,
    state: 'idle',
    toolName: null,
    transitionAt: 1_700_000_000_000,
    lastEventAt: null,
    compactionStartedAt: null,
    compactionProgressAt: null,
    ...overrides,
  };
}

function goodbye(ownerGeneration: number, overrides: Record<string, unknown> = {}) {
  const value = snapshot({ ownerGeneration, revision: 1, ...overrides });
  const snapshotOnly = new Set([
    'state',
    'toolName',
    'transitionAt',
    'lastEventAt',
    'compactionStartedAt',
    'compactionProgressAt',
  ]);
  return {
    ...Object.fromEntries(Object.entries(value).filter(([field]) => !snapshotOnly.has(field))),
    kind: 'goodbye',
  };
}

function generation(result: any): number {
  expect(result).toMatchObject({ ok: true, acceptedGeneration: expect.any(Number) });
  return result.acceptedGeneration;
}

function owner(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surfaceId: 'surface-a',
    sessionId: 'session-a',
    ownerGeneration: 1,
    pid: 4321,
    processStartedAt: 1_700_000_000_000,
    heartbeatAt: 1_700_000_001_000,
    disconnectedAt: null,
    liveness: 'live',
    snapshot: {
      state,
      toolName: state === 'tool-running' ? 'bash' : null,
      transitionAt: 1_700_000_001_000,
      lastEventAt: state === 'idle' || state === 'unknown' ? null : 1_700_000_001_000,
      compactionStartedAt: state === 'compacting' ? 1_700_000_001_000 : null,
      compactionProgressAt: state === 'compacting' ? 1_700_000_001_000 : null,
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('lifecycle v1 wire contract', () => {
  it('accepts every valid fixture and rejects every invalid fixture', async () => {
    const fixturePath = new URL(
      '../extensions/cmux-junction/wire-fixtures/v1.json',
      import.meta.url,
    );
    const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));

    for (const fixture of fixtures.valid) {
      expect(decodeWireMessage(fixture.message, fixtures.target), fixture.name).toMatchObject({
        ok: true,
      });
    }
    for (const fixture of fixtures.invalid) {
      expect(decodeWireMessage(fixture.message, fixtures.target), fixture.name).toMatchObject({
        ok: false,
      });
    }

    for (const fixture of fixtures.validAcks) {
      const expected = fixtures.valid.find(
        (candidate: { name: string }) => candidate.name === fixture.messageName,
      ).message;
      expect(decodeAckLine(JSON.stringify(fixture.message), expected), fixture.name).toMatchObject({
        ok: true,
      });
    }
    const expected = fixtures.valid[0].message;
    for (const fixture of fixtures.invalidAcks) {
      expect(decodeAckLine(JSON.stringify(fixture.message), expected), fixture.name).toMatchObject({
        ok: false,
      });
    }
  });

  it('contains no content-bearing protocol fields', async () => {
    const fixturePath = new URL(
      '../extensions/cmux-junction/wire-fixtures/v1.json',
      import.meta.url,
    );
    const text = await readFile(fixturePath, 'utf8');
    for (const forbidden of [
      'transcript',
      'toolArgs',
      'toolResult',
      'cwd',
      'branch',
      'socketPassword',
    ]) {
      expect(text).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('workspace aggregation', () => {
  const now = 1_700_000_002_000;

  it('uses deterministic active precedence and lets verified activity beat unresolved siblings', () => {
    const values = [
      owner('thinking', { surfaceId: 'surface-z' }),
      owner('error', { surfaceId: 'surface-b' }),
      owner('unknown', { surfaceId: 'surface-a', liveness: 'stale' }),
      owner('compacting', { surfaceId: 'surface-c' }),
    ];
    expect(aggregateOwners(values, now)).toEqual({ state: 'compacting', label: 'Compacting' });
    expect(aggregateOwners(values.reverse(), now)).toEqual({
      state: 'compacting',
      label: 'Compacting',
    });
  });

  it('prevents false Idle, clears an empty workspace, and keeps siblings independent', () => {
    expect(aggregateOwners([owner('idle'), owner('idle', { liveness: 'stale' })], now)).toEqual({
      state: 'unknown',
      label: 'Unknown',
    });
    expect(
      aggregateOwners([owner('idle'), owner('idle', { surfaceId: 'surface-b' })], now),
    ).toEqual({
      state: 'idle',
      label: 'Idle',
    });
    expect(aggregateOwners([], now)).toEqual({ state: null, label: null });
  });

  it('shows a safe tool name only for exactly one live non-idle owner', () => {
    expect(aggregateOwners([owner('tool-running')], now)).toEqual({
      state: 'tool-running',
      label: 'Tool running: bash',
    });
    expect(
      aggregateOwners([owner('tool-running'), owner('thinking', { surfaceId: 'surface-b' })], now),
    ).toEqual({ state: 'tool-running', label: 'Tool running' });
    expect(
      aggregateOwners([owner('tool-running'), owner('unknown', { surfaceId: 'surface-b' })], now),
    ).toEqual({ state: 'tool-running', label: 'Tool running' });
  });
});

describe('owner liveness', () => {
  const now = 1_700_000_031_000;
  const value = owner('idle') as any;

  it.each([
    ['match', 1_700_000_001_000, 'live'],
    ['match', 1_700_000_000_999, 'stale'],
    ['unverifiable', 1_700_000_031_000, 'stale'],
    ['missing', 1_700_000_031_000, 'dead'],
    ['reused', 1_700_000_031_000, 'dead'],
    ['match', 1_699_999_730_999, 'dead'],
  ])('classifies %s at the exact age boundary as %s', (probe, heartbeatAt, expected) => {
    expect(classifyOwner({ ...value, heartbeatAt }, now, () => probe)).toBe(expected);
  });

  it('treats future presence as unresolved', () => {
    expect(classifyOwner({ ...value, heartbeatAt: now + 10_001 }, now, () => 'match')).toBe(
      'stale',
    );
  });

  it('distinguishes matching starts, PID reuse, missing PIDs, and unverifiable starts', () => {
    const startedAt = Date.parse('Tue Aug 18 10:00:00 2026');
    expect(
      probePidStart(4321, startedAt, {
        signal: () => undefined,
        readStart: () => 'Tue Aug 18 10:00:00 2026',
      }),
    ).toBe('match');
    expect(
      probePidStart(4321, startedAt + 10_000, {
        signal: () => undefined,
        readStart: () => 'Tue Aug 18 10:00:00 2026',
      }),
    ).toBe('reused');
    expect(
      probePidStart(4321, startedAt, {
        signal: () => {
          throw Object.assign(new Error('missing'), { code: 'ESRCH' });
        },
      }),
    ).toBe('missing');
    expect(probePidStart(4321, startedAt, { signal: () => undefined, readStart: () => '' })).toBe(
      'unverifiable',
    );
  });
});

describe('coordinator runtime boundary', () => {
  it('accepts the exact client-launched argument contract and rejects additions', () => {
    const argv = [
      '--listen',
      '/tmp/coordinator.sock',
      '--ledger',
      '/tmp/ledger.json',
      '--cmux-socket',
      target.socketPath,
      '--workspace',
      target.workspaceId,
    ];
    expect(parseRuntimeArgs(argv)).toEqual({
      listen: '/tmp/coordinator.sock',
      ledger: '/tmp/ledger.json',
      'cmux-socket': target.socketPath,
      workspace: target.workspaceId,
    });
    expect(() => parseRuntimeArgs([...argv, '--extra', 'bad'])).toThrow();
  });
});

describe('coordinator ownership and publication', () => {
  it('assigns generations and fences stale snapshots, goodbyes, and EOF callbacks', async () => {
    let now = 1_700_000_001_000;
    const core = createCoordinatorCore({ target, now: () => now, probePid: () => 'match' });
    const first = await core.acceptSnapshot(snapshot());
    expect(first).toMatchObject({ ok: true, acceptedGeneration: 1, acceptedRevision: 0 });

    expect(await core.acceptSnapshot(snapshot({ ownerGeneration: 1, revision: 0 }))).toMatchObject({
      ok: false,
      reason: 'revision',
    });
    expect(
      await core.acceptSnapshot(
        snapshot({ ownerGeneration: 1, connectionId: 'connection-reconnected', revision: 1 }),
      ),
    ).toMatchObject({ ok: true, acceptedGeneration: 1, acceptedRevision: 1 });
    expect(
      await core.connectionClosed({
        surfaceId: 'surface-a',
        connectionId: 'connection-a',
        ownerGeneration: 1,
      }),
    ).toEqual({ ok: true, changed: false });

    const replacement = await core.acceptSnapshot(
      snapshot({ runtimeId: 'runtime-b', connectionId: 'connection-b', revision: 0 }),
    );
    expect(replacement).toMatchObject({ ok: true, acceptedGeneration: 2 });

    expect(await core.goodbye(goodbye(1))).toMatchObject({ ok: true, removed: false });
    expect(
      await core.connectionClosed({
        surfaceId: 'surface-a',
        connectionId: 'connection-a',
        ownerGeneration: 1,
      }),
    ).toEqual({ ok: true, changed: false });
    expect(core.ledger().owners).toHaveLength(1);
    expect(core.ledger().owners[0]).toMatchObject({ runtimeId: 'runtime-b', ownerGeneration: 2 });

    now += RECONNECT_GRACE_MS;
    await core.maintain();
    expect(core.ledger().owners).toHaveLength(1);
  });

  it('does not retain an owner whose PID identity is already dead', async () => {
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'missing',
    });
    expect(await core.acceptSnapshot(snapshot())).toMatchObject({ ok: false, reason: 'dead' });
    expect(core.ledger().owners).toHaveLength(0);
  });

  it('removes only the matching disconnected generation after grace', async () => {
    let now = 1_700_000_001_000;
    const core = createCoordinatorCore({ target, now: () => now, probePid: () => 'match' });
    const first = await core.acceptSnapshot(snapshot());
    await core.acceptSnapshot(
      snapshot({ surfaceId: 'surface-b', sessionId: 'session-b', connectionId: 'connection-b' }),
    );
    await core.connectionClosed({
      surfaceId: 'surface-a',
      connectionId: 'connection-a',
      ownerGeneration: generation(first),
    });

    now += RECONNECT_GRACE_MS - 1;
    await core.maintain();
    expect(core.ledger().owners).toHaveLength(2);
    now += 1;
    await core.maintain();
    expect(core.ledger().owners).toHaveLength(1);
    expect(core.ledger().owners[0].surfaceId).toBe('surface-b');
  });

  it('persists desired before publication, persists applied after success, and clears final owner', async () => {
    let now = 1_700_000_001_000;
    const events: string[] = [];
    const published: Array<{ state: string | null; label: string | null }> = [];
    const core = createCoordinatorCore({
      target,
      now: () => now,
      probePid: () => 'match',
      persist: async (ledger: any) => {
        events.push(`persist:${ledger.desired.state}:${ledger.applied.state}`);
      },
      publish: async (status: any) => {
        events.push(`publish:${status.state}`);
        published.push(status);
        return { ok: true };
      },
    });
    const registration = await core.acceptSnapshot(snapshot());
    await core.drain();
    expect(events.slice(0, 3)).toEqual(['persist:idle:null', 'publish:idle', 'persist:idle:idle']);

    await core.goodbye(goodbye(generation(registration)));
    await core.drain();
    expect(core.ledger()).toMatchObject({
      desired: { state: null, label: null },
      applied: { state: 'idle', label: 'Idle' },
    });
    now += RECONNECT_GRACE_MS;
    await core.maintain();
    await core.drain();
    expect(published.at(-1)).toEqual({ state: null, label: null });
    expect(core.ledger()).toMatchObject({
      owners: [],
      desired: { state: null, label: null },
      applied: { state: null, label: null },
    });
  });

  it('keeps failed desired state unapplied and replays it on reconcile', async () => {
    let succeed = false;
    const calls: unknown[] = [];
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
      publish: async (status: unknown) => {
        calls.push(status);
        return succeed ? { ok: true } : { ok: false, outcome: 'timed-out' };
      },
    });
    await core.acceptSnapshot(snapshot());
    await core.drain();
    expect(core.ledger()).toMatchObject({
      desired: { state: 'idle' },
      applied: { state: null },
    });
    expect(core.diagnostics()).toMatchObject({ deliveryOutcome: 'timed-out' });

    succeed = true;
    await core.reconcile();
    expect(calls).toHaveLength(2);
    expect(core.ledger()).toMatchObject({ applied: { state: 'idle' } });
  });

  it('retries active-owner publication with capped backoff', async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let attempts = 0;
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
      schedule: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
      publish: async () => {
        attempts += 1;
        return attempts < 3 ? { ok: false, outcome: 'exit-failed' } : { ok: true };
      },
    });

    await core.acceptSnapshot(snapshot());
    await core.drain();
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000]);
    scheduled.shift()?.callback();
    await core.drain();
    expect(scheduled.map(({ delay }) => delay)).toEqual([2_000]);
    scheduled.shift()?.callback();
    await core.drain();
    expect(core.ledger()).toMatchObject({ applied: { state: 'idle' } });
  });

  it('bounds final-owner clear to three attempts after reconnect grace', async () => {
    let now = 1_700_000_001_000;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const cleared: unknown[] = [];
    const core = createCoordinatorCore({
      target,
      now: () => now,
      probePid: () => 'match',
      schedule: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
      publish: async (status: any) => {
        if (status.state !== null) return { ok: true };
        cleared.push(status);
        return { ok: false, outcome: 'exit-failed' };
      },
    });
    const accepted = await core.acceptSnapshot(snapshot());
    await core.drain();
    await core.goodbye(goodbye(generation(accepted)));
    expect(scheduled.map(({ delay }) => delay)).toEqual([RECONNECT_GRACE_MS]);

    now += RECONNECT_GRACE_MS;
    scheduled.shift()?.callback();
    await core.drain();
    expect(scheduled.map(({ delay }) => delay)).toEqual([500]);
    now += 500;
    scheduled.shift()?.callback();
    await core.drain();
    expect(scheduled.map(({ delay }) => delay)).toEqual([1_000]);
    now += 1_000;
    scheduled.shift()?.callback();
    await core.drain();

    expect(cleared).toHaveLength(3);
    expect(scheduled).toHaveLength(0);
    expect(core.ledger()).toMatchObject({
      desired: { state: null },
      applied: { state: 'idle' },
    });
  });

  it('accepts one exact durable replay while retaining its generation', async () => {
    const first = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
    });
    const accepted = await first.acceptSnapshot(snapshot());
    await first.drain();

    const restarted = createCoordinatorCore({
      target,
      initialLedger: first.ledger(),
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
    });
    expect(
      await restarted.acceptSnapshot(
        snapshot({ ownerGeneration: generation(accepted), revision: 0 }),
      ),
    ).toMatchObject({ ok: true, acceptedGeneration: 1 });
    expect(restarted.ledger().owners[0]).toMatchObject({ replayPending: false, liveness: 'live' });
  });

  it('keeps diagnostics bounded and free of full identities', async () => {
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
    });
    await core.acceptSnapshot(snapshot({ sessionId: 'private-session-identifier' }));
    const diagnostics = JSON.stringify(core.diagnostics());
    expect(diagnostics).not.toContain('private-session-identifier');
    expect(diagnostics).not.toContain(target.socketPath);
  });
});

describe('atomic ledger store', () => {
  it('writes a flushed mode-0600 ledger and ignores malformed files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-junction-ledger-'));
    tempDirectories.push(directory);
    const path = join(directory, 'nested', 'ledger.json');
    const store = createAtomicLedgerStore(path);
    const ledger = { schemaVersion: 1, target };

    await store.write(ledger);
    expect(await store.read()).toEqual(ledger);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await (await import('node:fs/promises')).writeFile(path, '{truncated', { mode: 0o600 });
    await expect(store.read()).resolves.toBeNull();
  });
});
