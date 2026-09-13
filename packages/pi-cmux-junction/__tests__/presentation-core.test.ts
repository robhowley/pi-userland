import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createPresentationCore,
  MAX_PRESENTATION_SOURCES,
  PRESENTATION_DISCONNECT_GRACE_MS,
  PRESENTATION_MAINTENANCE_MS,
  PRESENTATION_RECEIPT_EXPIRY_MS,
  presentationSourceId,
} from '../extensions/cmux-junction/presentation-core.mjs';
import { PRESENTATION_PROTOCOL } from '../extensions/cmux-junction/presentation-protocol.mjs';

const target = { socketPath: '/tmp/a/../cmux.sock', workspaceId: 'workspace-a' };

function view(producerKey: string, itemKeys = ['item-a']) {
  return {
    producer: { key: producerKey, label: `Producer ${producerKey}` },
    items: itemKeys.map((key, index) => ({
      key,
      title: `Item ${index}`,
      status: index === 0 ? 'ready' : undefined,
      rows: [{ label: 'row', value: String(index) }],
    })),
  };
}

function heavyViews(count: number) {
  return Array.from({ length: count }, (_, blockIndex) => ({
    producer: { key: `heavy-${String(blockIndex).padStart(2, '0')}`, label: 'Heavy' },
    items: Array.from({ length: 8 }, (_, itemIndex) => ({
      key: `item-${itemIndex}`,
      title: 'Item',
      summary: '%'.repeat(512),
      rows: [],
    })),
  }));
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    protocol: PRESENTATION_PROTOCOL,
    kind: 'snapshot',
    workspaceId: target.workspaceId,
    surfaceId: 'surface-a',
    sessionId: 'session-a',
    runtimeId: 'runtime-a',
    pid: 4321,
    processStartedAt: 1_700_000_000_000,
    connectionId: 'connection-a',
    sourceGeneration: null,
    revision: 0,
    views: [view('producer-a')],
    ...overrides,
  };
}

function goodbye(generation: number, overrides: Record<string, unknown> = {}) {
  const message = snapshot({
    kind: 'goodbye',
    sourceGeneration: generation,
    revision: 1,
    ...overrides,
  });
  delete (message as any).views;
  return message;
}

function sourceId(message = snapshot()) {
  const tuple = [
    normalize(target.socketPath),
    message.workspaceId,
    message.surfaceId,
    message.sessionId,
    message.runtimeId,
    message.pid,
    message.processStartedAt,
  ];
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

function acceptedGeneration(result: any) {
  expect(result).toMatchObject({ ok: true, acceptedGeneration: expect.any(Number) });
  return result.acceptedGeneration as number;
}

describe('committed projection callback', () => {
  it('notifies after accepted heartbeats, empty snapshots, goodbye and actual expiry only', () => {
    let time = 0;
    const onProjection = vi.fn();
    const core = createPresentationCore({ target, now: () => time, onProjection });
    expect(onProjection).not.toHaveBeenCalled();
    core.maintain();
    expect(onProjection).not.toHaveBeenCalled();
    const generation = acceptedGeneration(core.acceptSnapshot(snapshot(), 'socket-a'));
    const first = core.projection();
    core.acceptSnapshot(snapshot({ revision: 1, sourceGeneration: generation }), 'socket-a');
    expect(core.projection()).toEqual(first);
    expect(onProjection).toHaveBeenCalledTimes(2);
    core.acceptSnapshot(
      snapshot({ revision: 2, views: [], sourceGeneration: generation }),
      'socket-a',
    );
    expect(core.isQuiescent()).toBe(false);
    expect(onProjection.mock.lastCall?.[0].kind).toBe('clear');
    expect(core.goodbye(goodbye(generation, { revision: 3 }), 'socket-a').ok).toBe(true);
    expect(onProjection).toHaveBeenCalledTimes(4);
    core.acceptSnapshot(snapshot({ connectionId: 'other' }), 'socket-b');
    time = PRESENTATION_RECEIPT_EXPIRY_MS;
    expect(core.maintain().changed).toBe(true);
    expect(onProjection).toHaveBeenCalledTimes(6);
    core.maintain();
    expect(onProjection).toHaveBeenCalledTimes(6);
  });

  it.each([
    'malformed',
    'wrong-target',
    'stale',
    'fenced',
    'dead',
    'capacity',
    'collision',
    'source-limit',
  ])('does not notify or move projection on %s rejection', (reason) => {
    const onProjection = vi.fn();
    let dead = false;
    let capacity = true;
    const core = createPresentationCore({
      target,
      onProjection,
      probePid: () => (dead ? 'missing' : 'match'),
      capacity: () => capacity,
      ...(reason === 'collision' ? { sourceId: () => 'a'.repeat(64) } : {}),
    });
    core.acceptSnapshot(snapshot(), 'socket-a');
    if (reason === 'source-limit') {
      for (let index = 1; index < MAX_PRESENTATION_SOURCES; index += 1)
        core.acceptSnapshot(snapshot({ runtimeId: `runtime-${index}` }), `socket-${index}`);
    }
    const before = core.projection();
    onProjection.mockClear();
    dead = reason === 'dead';
    capacity = reason !== 'capacity';
    const input =
      reason === 'malformed'
        ? {}
        : snapshot({
            revision: reason === 'stale' ? 0 : 1,
            ...(reason === 'wrong-target' ? { workspaceId: 'other' } : {}),
            ...(['collision', 'source-limit'].includes(reason) ? { runtimeId: 'new-runtime' } : {}),
            ...(reason === 'fenced' ? { sourceGeneration: 999 } : {}),
          });
    expect(
      core.acceptSnapshot(
        input,
        ['collision', 'source-limit'].includes(reason) ? 'new-socket' : 'socket-a',
      ).ok,
    ).toBe(false);
    expect(core.projection()).toBe(before);
    expect(onProjection).not.toHaveBeenCalled();
  });

  it('isolates thrown and asynchronous callback failures from acceptance', async () => {
    for (const onProjection of [
      () => {
        throw new Error('publication');
      },
      async () => {
        throw new Error('publication');
      },
    ]) {
      const core = createPresentationCore({ target, onProjection });
      expect(core.acceptSnapshot(snapshot(), 'socket-a').ok).toBe(true);
      await Promise.resolve();
      expect(core.isQuiescent()).toBe(false);
    }
  });
});

describe('presentation source identity and blocks', () => {
  it('uses the full stable tuple and full lowercase SHA-256', () => {
    const message = snapshot();
    const tuple = [
      normalize(target.socketPath),
      message.workspaceId,
      message.surfaceId,
      message.sessionId,
      message.runtimeId,
      message.pid,
      message.processStartedAt,
    ];
    expect(presentationSourceId(tuple)).toBe(sourceId(message));
    expect(presentationSourceId(tuple)).toMatch(/^[a-f0-9]{64}$/u);

    const core = createPresentationCore({ target, probePid: () => 'match' });
    const generation = acceptedGeneration(core.acceptSnapshot(message, 'socket-a'));
    expect(core.blocks()).toEqual([
      {
        sourceId: sourceId(message),
        producer: view('producer-a').producer,
        items: view('producer-a').items,
      },
    ]);

    expect(
      core.acceptSnapshot(
        snapshot({ connectionId: 'connection-b', sourceGeneration: null, revision: 0 }),
        'socket-b',
      ),
    ).toMatchObject({ ok: true, acceptedGeneration: generation + 1 });
    expect(core.blocks()[0].sourceId).toBe(sourceId(message));
  });

  it('keeps one block per source and producer with deterministic exact-key ordering', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    const second = snapshot({
      surfaceId: 'surface-b',
      sessionId: 'session-b',
      runtimeId: 'runtime-b',
      pid: 4322,
      connectionId: 'connection-b',
      views: [view('same', ['duplicate']), view('z-last', ['duplicate'])],
    });
    const first = snapshot({ views: [view('same', ['duplicate', 'kept-in-order'])] });
    core.acceptSnapshot(second, 'socket-b');
    core.acceptSnapshot(first, 'socket-a');

    const expected = [
      {
        sourceId: sourceId(first),
        producer: first.views[0]!.producer,
        items: first.views[0]!.items,
      },
      {
        sourceId: sourceId(second),
        producer: second.views[0]!.producer,
        items: second.views[0]!.items,
      },
    ].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    expect(core.blocks().slice(0, 2)).toEqual(expected);
    expect(core.blocks()[2]).toEqual({
      sourceId: sourceId(second),
      producer: second.views[1]!.producer,
      items: second.views[1]!.items,
    });
    expect(core.blocks()[0]!.items.map((item: any) => item.key)).toEqual(
      expected[0]!.items.map((item: any) => item.key),
    );
  });

  it('completely replaces one source while empty views retain its lease', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    const generation = acceptedGeneration(
      core.acceptSnapshot(snapshot({ views: [view('a'), view('b')] }), 'socket-a'),
    );
    core.acceptSnapshot(
      snapshot({ sourceGeneration: generation, revision: 1, views: [view('c')] }),
      'socket-a',
    );
    expect(core.blocks().map((block: any) => block.producer.key)).toEqual(['c']);

    core.acceptSnapshot(
      snapshot({ sourceGeneration: generation, revision: 2, views: [] }),
      'socket-a',
    );
    expect(core.blocks()).toEqual([]);
    expect(core.projection()).toMatchObject({ kind: 'clear', metrics: { byteCount: 0 } });
    expect(core.isQuiescent()).toBe(false);
    expect(core.diagnostics()).toMatchObject({ sourceCount: 1, blockCount: 0 });
  });

  it('fails closed when distinct tuples produce the same digest', () => {
    const digest = '0'.repeat(64);
    const core = createPresentationCore({
      target,
      sourceId: () => digest,
      probePid: () => 'match',
    });
    core.acceptSnapshot(snapshot(), 'socket-a');
    const before = core.diagnostics();
    expect(
      core.acceptSnapshot(
        snapshot({ surfaceId: 'surface-b', sessionId: 'session-b', revision: 1 }),
        'socket-b',
      ),
    ).toEqual({ ok: false, reason: 'identity-collision' });
    expect(core.diagnostics()).toEqual(before);
  });

  it('isolates workspace targets', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    expect(core.acceptSnapshot(snapshot({ workspaceId: 'workspace-b' }), 'socket-a')).toEqual({
      ok: false,
      reason: 'wrong-target',
    });
    expect(core.isQuiescent()).toBe(true);
  });
});

describe('presentation candidate transaction', () => {
  it('starts clear, rejects an oversized first source, and accepts a smaller same-revision retry', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    const clear = core.projection();
    expect(clear).toMatchObject({ kind: 'clear', metrics: { byteCount: 0 } });

    expect(core.acceptSnapshot(snapshot({ views: heavyViews(64) }), 'socket-a')).toEqual({
      ok: false,
      reason: 'capacity',
    });
    expect(core.projection()).toBe(clear);
    expect(core.diagnostics()).toMatchObject({ sourceCount: 0, nextGeneration: 0 });

    expect(core.acceptSnapshot(snapshot({ views: [view('small')] }), 'socket-a')).toMatchObject({
      ok: true,
      acceptedGeneration: 1,
      acceptedRevision: 0,
    });
    expect(core.projection()).toMatchObject({ kind: 'set', digest: expect.any(String) });
  });

  it('accepts a replacement that frees aggregate capacity', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    const firstGeneration = acceptedGeneration(
      core.acceptSnapshot(snapshot({ views: heavyViews(48) }), 'socket-a'),
    );
    const second = snapshot({
      surfaceId: 'surface-b',
      sessionId: 'session-b',
      runtimeId: 'runtime-b',
      pid: 4322,
      connectionId: 'connection-b',
      views: heavyViews(8),
    });
    expect(core.acceptSnapshot(second, 'socket-b')).toMatchObject({ ok: true });
    const before = core.projection();

    expect(
      core.acceptSnapshot(
        snapshot({
          sourceGeneration: firstGeneration,
          revision: 1,
          views: heavyViews(56),
        }),
        'socket-a',
      ),
    ).toEqual({ ok: false, reason: 'capacity' });
    expect(core.projection()).toBe(before);

    expect(
      core.acceptSnapshot(
        snapshot({ sourceGeneration: firstGeneration, revision: 1, views: [view('small')] }),
        'socket-a',
      ),
    ).toMatchObject({ ok: true });
    expect(core.projection()).toMatchObject({ kind: 'set' });
    expect(core.projection()).not.toBe(before);
  });

  it('preserves state, generation, revision, receipt lease, blocks, and projection on rejection', () => {
    let now = 10_000;
    let capacity = true;
    const core = createPresentationCore({
      target,
      now: () => now,
      probePid: () => 'match',
      capacity: () => capacity,
    });
    const generation = acceptedGeneration(core.acceptSnapshot(snapshot(), 'socket-a'));
    const beforeBlocks = core.blocks();
    const beforeProjection = core.projection();
    const beforeDiagnostics = core.diagnostics();

    capacity = false;
    now += PRESENTATION_RECEIPT_EXPIRY_MS - 1;
    expect(
      core.acceptSnapshot(
        snapshot({ sourceGeneration: generation, revision: 1, views: [view('replacement')] }),
        'socket-a',
      ),
    ).toEqual({ ok: false, reason: 'capacity' });
    expect(core.blocks()).toBe(beforeBlocks);
    expect(core.projection()).toBe(beforeProjection);
    expect(core.diagnostics()).toEqual(beforeDiagnostics);

    now += 1;
    expect(core.maintain()).toEqual({ ok: true, changed: true });
    expect(core.isQuiescent()).toBe(true);
  });

  it('rejects stale revisions, wrong generations, reused PIDs, and thrown capacity checks', () => {
    let pid = 'match';
    let throwCapacity = false;
    const core = createPresentationCore({
      target,
      probePid: () => pid,
      capacity: () => {
        if (throwCapacity) throw new Error('no projection');
        return true;
      },
    });
    const generation = acceptedGeneration(core.acceptSnapshot(snapshot(), 'socket-a'));
    expect(
      core.acceptSnapshot(snapshot({ sourceGeneration: generation, revision: 0 }), 'socket-a'),
    ).toEqual({ ok: false, reason: 'stale-revision' });
    expect(
      core.acceptSnapshot(snapshot({ sourceGeneration: generation + 1, revision: 1 }), 'socket-a'),
    ).toEqual({ ok: false, reason: 'fenced' });
    pid = 'reused';
    expect(
      core.acceptSnapshot(snapshot({ sourceGeneration: generation, revision: 1 }), 'socket-a'),
    ).toEqual({ ok: false, reason: 'dead-source' });
    pid = 'match';
    throwCapacity = true;
    expect(
      core.acceptSnapshot(snapshot({ sourceGeneration: generation, revision: 1 }), 'socket-a'),
    ).toEqual({ ok: false, reason: 'capacity' });
    expect(core.blocks()[0].producer.key).toBe('producer-a');
  });

  it('enforces 16 sources without consuming a generation on rejection', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    for (let index = 0; index < MAX_PRESENTATION_SOURCES; index += 1) {
      expect(
        core.acceptSnapshot(
          snapshot({
            surfaceId: `surface-${index}`,
            sessionId: `session-${index}`,
            runtimeId: `runtime-${index}`,
            pid: 5_000 + index,
            connectionId: `connection-${index}`,
            views: [],
          }),
          `socket-${index}`,
        ),
      ).toMatchObject({ ok: true, acceptedGeneration: index + 1 });
    }
    expect(
      core.acceptSnapshot(
        snapshot({
          surfaceId: 'overflow',
          sessionId: 'overflow',
          runtimeId: 'overflow',
          pid: 9_999,
          connectionId: 'overflow',
          views: [],
        }),
        'socket-overflow',
      ),
    ).toEqual({ ok: false, reason: 'source-limit' });
    expect(core.diagnostics()).toMatchObject({
      sourceCount: MAX_PRESENTATION_SOURCES,
      nextGeneration: MAX_PRESENTATION_SOURCES,
    });
  });
});

describe('presentation fencing and liveness', () => {
  it('rebinds stable reconnects and ignores the late old EOF', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    const generation = acceptedGeneration(core.acceptSnapshot(snapshot(), 'socket-old'));
    expect(
      core.acceptSnapshot(snapshot({ sourceGeneration: generation, revision: 1 }), 'socket-new'),
    ).toMatchObject({ ok: true, acceptedGeneration: generation });
    const blocks = core.blocks();
    expect(
      core.acceptSnapshot(
        snapshot({
          sourceGeneration: generation,
          revision: 2,
          views: [view('late-old-socket')],
        }),
        'socket-old',
      ),
    ).toEqual({ ok: false, reason: 'fenced' });
    expect(core.blocks()).toBe(blocks);
    expect(core.connectionClosed('socket-old')).toEqual({ ok: true, changed: false });
    expect(core.diagnostics()).toMatchObject({ sourceCount: 1, connectedCount: 1 });
  });

  it('assigns new generations to takeovers and reconnects after grace', () => {
    let now = 0;
    const core = createPresentationCore({ target, now: () => now, probePid: () => 'match' });
    const first = acceptedGeneration(core.acceptSnapshot(snapshot(), 'socket-a'));
    const second = acceptedGeneration(
      core.acceptSnapshot(
        snapshot({ connectionId: 'connection-b', sourceGeneration: null, revision: 0 }),
        'socket-b',
      ),
    );
    expect(second).toBe(first + 1);
    expect(core.connectionClosed('socket-a')).toEqual({ ok: true, changed: false });

    core.connectionClosed('socket-b');
    now = PRESENTATION_DISCONNECT_GRACE_MS;
    core.maintain();
    expect(
      core.acceptSnapshot(
        snapshot({
          connectionId: 'connection-b',
          sourceGeneration: second,
          revision: 1,
        }),
        'socket-after-grace',
      ),
    ).toMatchObject({ ok: true, acceptedGeneration: second + 1 });
  });

  it('uses exact disconnect grace and receipt expiry boundaries', () => {
    let now = 0;
    const emptied = vi.fn();
    const core = createPresentationCore({
      target,
      now: () => now,
      probePid: () => 'unverifiable',
      onEmpty: emptied,
    });
    core.acceptSnapshot(snapshot(), 'socket-a');
    core.connectionClosed('socket-a');
    now = PRESENTATION_DISCONNECT_GRACE_MS - 1;
    expect(core.maintain()).toEqual({ ok: true, changed: false });
    now = PRESENTATION_DISCONNECT_GRACE_MS;
    expect(core.maintain()).toEqual({ ok: true, changed: true });
    expect(emptied).toHaveBeenCalledOnce();

    now = 100_000;
    core.acceptSnapshot(snapshot({ connectionId: 'connection-b' }), 'socket-b');
    now += PRESENTATION_RECEIPT_EXPIRY_MS - 1;
    expect(core.maintain()).toEqual({ ok: true, changed: false });
    now += 1;
    expect(core.maintain()).toEqual({ ok: true, changed: true });
    expect(PRESENTATION_MAINTENANCE_MS).toBe(30_000);
  });

  it('lets maintenance remove missing or reused accepted sources', () => {
    let pid = 'match';
    const core = createPresentationCore({ target, probePid: () => pid });
    core.acceptSnapshot(snapshot(), 'socket-a');
    pid = 'missing';
    expect(core.maintain()).toEqual({ ok: true, changed: true });

    pid = 'match';
    core.acceptSnapshot(snapshot({ connectionId: 'connection-b' }), 'socket-b');
    pid = 'reused';
    expect(core.maintain()).toEqual({ ok: true, changed: true });
  });

  it('removes only an exact newer goodbye and fences later traffic on that socket', () => {
    const core = createPresentationCore({ target, probePid: () => 'match' });
    const generation = acceptedGeneration(core.acceptSnapshot(snapshot(), 'socket-a'));
    expect(core.goodbye(goodbye(generation, { revision: 0 }), 'socket-a')).toEqual({
      ok: false,
      reason: 'fenced',
    });
    expect(core.goodbye(goodbye(generation), 'socket-old')).toEqual({
      ok: false,
      reason: 'fenced',
    });
    expect(core.goodbye(goodbye(generation), 'socket-a')).toMatchObject({
      ok: true,
      removed: true,
    });
    expect(core.projection()).toMatchObject({ kind: 'clear' });
    expect(
      core.acceptSnapshot(snapshot({ sourceGeneration: generation, revision: 2 }), 'socket-a'),
    ).toEqual({ ok: false, reason: 'fenced' });
    expect(core.connectionClosed('socket-a')).toEqual({ ok: true, changed: false });
  });

  it('accepts replay into empty restarted memory with a coordinator-owned generation', () => {
    const first = createPresentationCore({ target, probePid: () => 'match' });
    const oldGeneration = acceptedGeneration(first.acceptSnapshot(snapshot(), 'socket-a'));
    const restarted = createPresentationCore({ target, probePid: () => 'match' });
    expect(
      restarted.acceptSnapshot(
        snapshot({ sourceGeneration: oldGeneration, revision: 1 }),
        'socket-replay',
      ),
    ).toMatchObject({ ok: true, acceptedGeneration: 1 });
    expect(restarted.blocks()).toHaveLength(1);
  });
});
