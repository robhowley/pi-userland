import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECONNECT_GRACE_MS,
  aggregateOwners,
  buildCmuxStatusArgs,
  classifyOwner,
  createAtomicLedgerStore,
  createCoordinatorCore,
  decodeAckLine,
  decodeWireMessage,
  parseRuntimeArgs,
  probePidStart,
  resolveCmuxExecutable,
  runCmux,
  runCoordinatorRuntime,
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

function accept(core: any, message: Record<string, unknown>, socketToken = 'socket-a') {
  return core.acceptSnapshot(message, socketToken);
}

function release(core: any, message: Record<string, unknown>, socketToken = 'socket-a') {
  return core.goodbye(message, socketToken);
}

function owner(state: string, overrides: Record<string, unknown> = {}): any {
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

  it('validates every timestamp before Idle and accepts the exact future boundary', () => {
    const exact = owner('idle', {
      snapshot: {
        ...owner('idle').snapshot,
        transitionAt: now + 5_000,
        lastEventAt: now + 5_000,
      },
    });
    expect(aggregateOwners([exact], now)).toEqual({ state: 'idle', label: 'Idle' });

    const future = owner('idle', {
      surfaceId: 'surface-b',
      snapshot: { ...owner('idle').snapshot, transitionAt: now + 5_001 },
    });
    expect(aggregateOwners([owner('idle'), future], now)).toEqual({
      state: 'unknown',
      label: 'Unknown',
    });
  });

  it.each([
    ['one-sided compaction', { compactionStartedAt: now, compactionProgressAt: null }],
    [
      'reversed compaction',
      { compactionStartedAt: now, compactionProgressAt: now - 1, lastEventAt: now },
    ],
    [
      'compaction newer than activity',
      { compactionStartedAt: now, compactionProgressAt: now, lastEventAt: now - 1 },
    ],
    ['future compaction', { compactionStartedAt: now, compactionProgressAt: now + 5_001 }],
    [
      'expired compaction',
      {
        compactionStartedAt: now - 600_001,
        compactionProgressAt: now - 600_001,
        lastEventAt: now - 600_001,
      },
    ],
  ])('treats %s timestamps as Unknown before state reduction', (_name, snapshotOverrides) => {
    expect(
      aggregateOwners(
        [
          owner('idle', {
            snapshot: { ...owner('idle').snapshot, ...snapshotOverrides },
          }),
        ],
        now,
      ),
    ).toEqual({ state: 'unknown', label: 'Unknown' });
  });

  it('accepts coherent compaction timestamps at the exact future boundary', () => {
    expect(
      aggregateOwners(
        [
          owner('compacting', {
            snapshot: {
              ...owner('compacting').snapshot,
              transitionAt: now + 5_000,
              lastEventAt: now + 5_000,
              compactionStartedAt: now + 5_000,
              compactionProgressAt: now + 5_000,
            },
          }),
        ],
        now,
      ),
    ).toEqual({ state: 'compacting', label: 'Compacting' });
  });

  it.each(['idle', 'thinking'])('rejects fresh compaction evidence on %s', (state) => {
    const current = owner(state, {
      snapshot: {
        ...owner(state).snapshot,
        lastEventAt: now,
        compactionStartedAt: now,
        compactionProgressAt: now,
      },
    });
    expect(aggregateOwners([current], now)).toEqual({ state: 'unknown', label: 'Unknown' });
  });

  it('exposes a lower state only after compaction demotion and before expiry', () => {
    const at = (progressAt: number) =>
      owner('thinking', {
        snapshot: {
          ...owner('thinking').snapshot,
          lastEventAt: now,
          compactionStartedAt: progressAt,
          compactionProgressAt: progressAt,
        },
      });

    expect(aggregateOwners([at(now - 120_000)], now)).toEqual({
      state: 'unknown',
      label: 'Unknown',
    });
    expect(aggregateOwners([at(now - 120_001)], now)).toEqual({
      state: 'thinking',
      label: 'Thinking',
    });
    expect(aggregateOwners([at(now - 600_000)], now)).toEqual({
      state: 'thinking',
      label: 'Thinking',
    });
    expect(aggregateOwners([at(now - 600_001)], now)).toEqual({
      state: 'unknown',
      label: 'Unknown',
    });
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

  it('binds one owner per socket and closes tracked sockets after final clear', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-junction-runtime-'));
    tempDirectories.push(directory);
    const listen = join(directory, 'coordinator.sock');
    const ledger = join(directory, 'ledger.json');
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const published: unknown[] = [];
    let now = 1_700_000_001_000;
    const runtime = await runCoordinatorRuntime(
      [
        '--listen',
        listen,
        '--ledger',
        ledger,
        '--cmux-socket',
        target.socketPath,
        '--workspace',
        target.workspaceId,
      ],
      {
        randomId: () => 'private-socket-token',
        now: () => now,
        probePid: () => 'match',
        schedule: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
        publish: async (status: unknown) => {
          published.push(status);
          return { ok: true };
        },
      },
    );
    const socket = createConnection(listen);
    await once(socket, 'connect');
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (received += chunk));

    socket.write(`${JSON.stringify(snapshot())}\n`);
    await vi.waitFor(() => expect(received.split('\n').filter(Boolean)).toHaveLength(1));
    socket.write(`${JSON.stringify(goodbye(1))}\n`);
    await vi.waitFor(() => expect(received.split('\n').filter(Boolean)).toHaveLength(2));
    expect(scheduled[0]?.delay).toBe(RECONNECT_GRACE_MS);

    const serverClosed = once(runtime.server, 'close');
    const closed = once(socket, 'close');
    now += RECONNECT_GRACE_MS;
    scheduled.shift()!.callback();
    await closed;
    await serverClosed;
    await runtime.core.drain();
    expect(socket.destroyed).toBe(true);
    expect(published).toEqual([
      { state: 'idle', label: 'Idle' },
      { state: null, label: null },
    ]);
  });
});

describe('coordinator cmux publisher boundary', () => {
  it('selects only an executable bundled CLI and builds exact hostile set/clear argv', async () => {
    const executableAccess = async () => undefined;
    await expect(
      resolveCmuxExecutable({ CMUX_BUNDLED_CLI_PATH: '  /bundle/cmux  ' }, executableAccess),
    ).resolves.toBe('/bundle/cmux');
    await expect(resolveCmuxExecutable({}, executableAccess)).resolves.toBe('cmux');
    await expect(
      resolveCmuxExecutable({ CMUX_BUNDLED_CLI_PATH: '/missing' }, async () => {
        throw new Error('missing');
      }),
    ).resolves.toBe('cmux');

    const hostile = { socketPath: '/tmp/socket; touch nope', workspaceId: 'workspace $(nope)' };
    const styles = [
      ['idle', 'Idle', 'pause.circle.fill', '#8E8E93', '0'],
      ['thinking', 'Thinking', 'brain', '#4C8DFF', '0'],
      ['tool-running', 'Tool running: bash', 'wrench.fill', '#4C8DFF', '0'],
      ['awaiting-input', 'Needs input', 'bell.fill', '#FF9F0A', '100'],
      ['compacting', 'Compacting', 'trash.fill', '#4C8DFF', '0'],
      ['error', 'Error', 'exclamationmark.triangle.fill', '#FF453A', '100'],
      ['unknown', 'Unknown', 'questionmark.circle', '#8E8E93', '50'],
    ] as const;
    for (const [state, label, icon, color, priority] of styles) {
      expect(buildCmuxStatusArgs(hostile, { state, label })).toEqual([
        '--socket',
        hostile.socketPath,
        'set-status',
        'pi-junction',
        label,
        '--workspace',
        hostile.workspaceId,
        '--icon',
        icon,
        '--color',
        color,
        '--priority',
        priority,
      ]);
    }
    expect(() => buildCmuxStatusArgs(hostile, { state: 'unhandled', label: 'Unhandled' })).toThrow(
      'missing cmux status style',
    );
    expect(buildCmuxStatusArgs(hostile, { state: null, label: null })).toEqual([
      '--socket',
      hostile.socketPath,
      'clear-status',
      'pi-junction',
      '--workspace',
      hostile.workspaceId,
    ]);
  });

  it.each([
    [null, { ok: true, outcome: 'delivered' }],
    [{ killed: true }, { ok: false, outcome: 'timed-out' }],
    [{ signal: 'SIGTERM' }, { ok: false, outcome: 'signaled' }],
    [{ code: 7 }, { ok: false, outcome: 'exit-failed' }],
    [{ code: 'ENOENT' }, { ok: false, outcome: 'spawn-failed' }],
  ])('uses shell-free execFile with bounded timeout and maps %#', async (error, expected) => {
    const calls: any[] = [];
    const execute = (file: string, args: string[], options: object, callback: Function) => {
      calls.push({ file, args, options });
      callback(error);
    };
    await expect(
      runCmux(
        'sentinel-not-a-real-cmux',
        ['--socket', '/tmp/cmux.sock', 'clear-status', 'pi-junction'],
        { CMUX_SOCKET_PASSWORD: 'memory-only' },
        execute as any,
      ),
    ).resolves.toEqual(expected);
    expect(calls).toEqual([
      {
        file: 'sentinel-not-a-real-cmux',
        args: ['--socket', '/tmp/cmux.sock', 'clear-status', 'pi-junction'],
        options: {
          env: { CMUX_SOCKET_PASSWORD: 'memory-only' },
          timeout: 2_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          shell: false,
        },
      },
    ]);
  });
});

describe('coordinator ownership and publication', () => {
  it('fences ownership by physical socket through reconnect and late EOF races', async () => {
    let now = 1_700_000_001_000;
    const core = createCoordinatorCore({ target, now: () => now, probePid: () => 'match' });
    const first = await accept(core, snapshot(), 'socket-old');
    expect(first).toMatchObject({ ok: true, acceptedGeneration: 1, acceptedRevision: 0 });

    expect(
      await accept(core, snapshot({ ownerGeneration: 1, revision: 0 }), 'socket-old'),
    ).toMatchObject({ ok: false, reason: 'revision' });
    expect(
      await accept(
        core,
        snapshot({ ownerGeneration: 1, revision: 1, state: 'error' }),
        'socket-new',
      ),
    ).toMatchObject({ ok: true, acceptedGeneration: 1, acceptedRevision: 1 });

    expect(await core.connectionClosed('socket-old')).toEqual({ ok: true, changed: false });
    expect(
      await accept(core, snapshot({ ownerGeneration: 1, revision: 2 }), 'socket-old'),
    ).toMatchObject({ ok: false, reason: 'fence' });
    expect(
      await accept(
        core,
        snapshot({
          surfaceId: 'surface-b',
          sessionId: 'session-b',
          connectionId: 'connection-b',
          ownerGeneration: null,
          revision: 0,
        }),
        'socket-new',
      ),
    ).toMatchObject({ ok: false, reason: 'socket-owner' });

    expect(await core.connectionClosed('socket-new')).toEqual({ ok: true, changed: true });
    now += RECONNECT_GRACE_MS;
    await core.maintain();
    expect(core.ledger().owners).toHaveLength(0);

    const reregistered = await accept(
      core,
      snapshot({ ownerGeneration: 1, revision: 2 }),
      'socket-reregistered',
    );
    expect(reregistered).toMatchObject({ ok: true, acceptedGeneration: 2 });
    expect(await core.connectionClosed('socket-old')).toEqual({ ok: true, changed: false });
    expect(core.ledger().owners[0]).toMatchObject({ ownerGeneration: 2, acceptedRevision: 2 });
    expect(core.ledger().owners[0]).not.toHaveProperty('socketToken');
  });

  it('does not retain an owner whose PID identity is already dead', async () => {
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'missing',
    });
    expect(await accept(core, snapshot())).toMatchObject({ ok: false, reason: 'dead' });
    expect(core.ledger().owners).toHaveLength(0);
  });

  it('rejects a dead same-surface replacement without evicting the live owner', async () => {
    const now = 1_700_000_001_000;
    const core = createCoordinatorCore({
      target,
      now: () => now,
      probePid: (pid: number) => (pid === 4321 ? 'match' : 'missing'),
    });
    await accept(core, snapshot(), 'socket-live');
    await core.drain();

    expect(
      await accept(
        core,
        snapshot({
          sessionId: 'session-dead',
          runtimeId: 'runtime-dead',
          connectionId: 'connection-dead',
          pid: 9876,
          processStartedAt: 1_700_000_000_000,
          ownerGeneration: null,
          revision: 0,
        }),
        'socket-dead',
      ),
    ).toMatchObject({ ok: false, reason: 'dead' });
    await core.drain();

    expect(core.ledger().owners).toHaveLength(1);
    expect(core.ledger().owners[0]).toMatchObject({
      surfaceId: 'surface-a',
      sessionId: 'session-a',
      runtimeId: 'runtime-a',
      pid: 4321,
      ownerGeneration: 1,
    });
    expect(core.ledger()).toMatchObject({
      desired: { state: 'idle', label: 'Idle' },
    });
  });

  it('removes only the matching disconnected generation after grace', async () => {
    let now = 1_700_000_001_000;
    const core = createCoordinatorCore({ target, now: () => now, probePid: () => 'match' });
    const first = await accept(core, snapshot(), 'socket-a');
    await accept(
      core,
      snapshot({ surfaceId: 'surface-b', sessionId: 'session-b', connectionId: 'connection-b' }),
      'socket-b',
    );
    expect(generation(first)).toBe(1);
    await core.connectionClosed('socket-a');

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
    const registration = await accept(core, snapshot());
    await core.drain();
    expect(events.slice(0, 3)).toEqual(['persist:idle:null', 'publish:idle', 'persist:idle:idle']);

    await release(core, goodbye(generation(registration)));
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

  it('keeps failed active publication unapplied without a retry timer and retries on a heartbeat', async () => {
    let succeed = false;
    const calls: unknown[] = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
      schedule: (callback: () => void, delay: number) => scheduled.push({ callback, delay }),
      publish: async (status: unknown) => {
        calls.push(status);
        return succeed ? { ok: true } : { ok: false, outcome: 'timed-out' };
      },
    });
    await accept(core, snapshot());
    await core.drain();
    expect(core.ledger()).toMatchObject({
      desired: { state: 'idle' },
      applied: { state: null },
    });
    expect(core.diagnostics()).toMatchObject({ deliveryOutcome: 'timed-out' });
    expect(calls).toHaveLength(1);
    expect(scheduled).toEqual([]);

    succeed = true;
    await accept(core, snapshot({ ownerGeneration: 1, revision: 1, sentAt: 1_700_000_001_001 }));
    await core.drain();
    expect(calls).toHaveLength(2);
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
    const accepted = await accept(core, snapshot());
    await core.drain();
    await release(core, goodbye(generation(accepted)));
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

  it('dedupes only a successfully applied identical aggregate', async () => {
    const published: unknown[] = [];
    const core = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
      publish: async (status: unknown) => {
        published.push(status);
        return { ok: true };
      },
    });
    await accept(core, snapshot());
    await core.drain();
    await accept(core, snapshot({ ownerGeneration: 1, revision: 1, sentAt: 1_700_000_001_001 }));
    await core.drain();
    expect(published).toEqual([{ state: 'idle', label: 'Idle' }]);
  });

  it('requires a strictly newer revision for durable replay', async () => {
    const first = createCoordinatorCore({
      target,
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
    });
    const accepted = await accept(first, snapshot());
    await first.drain();

    const restarted = createCoordinatorCore({
      target,
      initialLedger: first.ledger(),
      now: () => 1_700_000_001_000,
      probePid: () => 'match',
    });
    expect(
      await accept(
        restarted,
        snapshot({ ownerGeneration: generation(accepted), revision: 0 }),
        'socket-equal-same',
      ),
    ).toMatchObject({ ok: false, reason: 'revision' });
    expect(
      await accept(
        restarted,
        snapshot({ ownerGeneration: generation(accepted), revision: 0, state: 'error' }),
        'socket-equal-different',
      ),
    ).toMatchObject({ ok: false, reason: 'revision' });
    expect(
      await accept(
        restarted,
        snapshot({ ownerGeneration: generation(accepted), revision: 1 }),
        'socket-restarted',
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
    await accept(core, snapshot({ sessionId: 'private-session-identifier' }));
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
