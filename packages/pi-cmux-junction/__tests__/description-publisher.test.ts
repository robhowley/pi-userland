import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import {
  createDescriptionPublisher,
  DESCRIPTION_OUTPUT_BOUND,
  runDescriptionCommand,
} from '../extensions/cmux-junction/description-publisher.mjs';
import { projectPresentationJ1 } from '../extensions/cmux-junction/presentation-j1.mjs';

const reservation = {
  socketPath: '/tmp/a/../cmux.sock',
  windowId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
  workspaceId: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
};
const clear = projectPresentationJ1([]);
function set(label = '日本語 $(echo no); "quoted"'): any {
  return projectPresentationJ1([
    {
      sourceId: 'a'.repeat(64),
      producer: { key: 'test', label },
      items: [{ key: 'card', title: 'Card', rows: [] }],
    },
  ]);
}
function list(description: unknown) {
  return {
    window_id: reservation.windowId,
    workspaces: [{ id: reservation.workspaceId, description, remote: null }],
  };
}
function fake(initial: string | null = null) {
  let value = initial;
  const calls: string[][] = [];
  const runCommand = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args.includes('list'))
      return { ok: true, stdout: Buffer.from(JSON.stringify(list(value))) };
    value = args.includes('set-description') ? args.at(-1)! : null;
    return { ok: true };
  });
  const publisher = createDescriptionPublisher({ reservation, runCommand });
  return {
    publisher,
    runCommand,
    calls,
    get: () => value,
    put: (next: string | null) => {
      value = next;
    },
  };
}
async function publish(f: ReturnType<typeof fake>, intent = set()) {
  expect(f.publisher.setDesired(intent)).toBe(true);
  await f.publisher.reconcile();
}

describe('description reservation and process boundary', () => {
  it('replaces canonical-equivalent text with distinct body tags and exact bytes', async () => {
    const f = fake();
    const composed = set('é');
    const decomposed = set('e\u0301');
    expect(composed.j1.slice(68).normalize('NFD')).toBe(decomposed.j1.slice(68));
    expect(composed.j1.slice(3, 67)).not.toBe(decomposed.j1.slice(3, 67));
    await publish(f, composed);
    await publish(f, decomposed);
    expect(f.get()).toBe(decomposed.j1);
    expect(f.calls.filter((args) => args.includes('set-description'))).toHaveLength(2);
    expect(decomposed.j1.endsWith('\u001d')).toBe(true);
  });
  it.each(['J1', 'J1␞S␟0␟' + 'a'.repeat(64)])(
    'never migrates or clears old prototype text: %s',
    async (old) => {
      for (const intent of [set(), clear]) {
        const f = fake(old);
        await publish(f, intent);
        expect(f.get()).toBe(old);
        expect(f.publisher.diagnostics().reservation).toBe('lost');
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toContain('list');
      }
    },
  );
  it('rejects wrong body hashes even when the whole-description digest matches', () => {
    const original = set();
    const j1 = original.j1.slice(0, 3) + '0'.repeat(64) + original.j1.slice(67);
    const forged = Object.freeze({
      ...original,
      j1,
      digest: createHash('sha256').update(j1, 'utf8').digest('hex'),
    });
    const f = fake();
    expect(f.publisher.setDesired(forged)).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it.each([
    undefined,
    null,
    {},
    [],
    1,
    { ...reservation, extra: true },
    { ...reservation, [Symbol('hidden')]: true },
    Object.create(reservation),
    Object.assign(Object.create({ foreign: true }), reservation),
    {
      ...reservation,
      get windowId() {
        throw new Error('never read');
      },
    },
    ...['', ' ', 'relative', '/tmp/\0x', '/tmp/\nx', '/tmp/\u0085x'].map((socketPath) => ({
      ...reservation,
      socketPath,
    })),
    ...['', 'workspace:1', '1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'].map((workspaceId) => ({
      ...reservation,
      workspaceId,
    })),
    { ...reservation, windowId: 'window:1' },
  ])('disables invalid/missing reservations with zero I/O: %#', async (input) => {
    const runCommand = vi.fn();
    const p = createDescriptionPublisher({ reservation: input, runCommand });
    p.setDesired(set());
    await p.reconcile();
    await p.drain();
    await p.shutdown();
    expect(p.isIdle()).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(p.diagnostics()).toEqual({
      reservation: 'disabled',
      reason: input === null || input === undefined ? 'missing' : 'invalid',
    });
  });
  it('reads the pinned list-shape fixture without using refs or unrelated fields', async () => {
    const stdout = await readFile(
      new URL(
        '../extensions/cmux-junction/wire-fixtures/cmux-workspace-list-0.64.22.json',
        import.meta.url,
      ),
    );
    const runCommand = vi.fn(async () => ({ ok: true, stdout }));
    const p = createDescriptionPublisher({ reservation, runCommand });
    p.setDesired(clear);
    await p.reconcile();
    expect(p.diagnostics()).toMatchObject({ reservation: 'held', applied: 'clear' });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it('permanently disables target mismatch', async () => {
    const runCommand = vi.fn();
    const p = createDescriptionPublisher({
      reservation,
      workspaceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      runCommand,
    });
    p.setDesired(set());
    await p.reconcile();
    expect(runCommand).not.toHaveBeenCalled();
  });
  it('has no initial intent or I/O; exact UUID argv, local window, one payload argument', async () => {
    const f = fake();
    await f.publisher.reconcile();
    expect(f.calls).toEqual([]);
    expect(f.publisher.diagnostics()).toMatchObject({
      reservation: 'unclaimed',
      desired: 'no-intent',
      applied: 'unknown',
    });
    const intent = set();
    await publish(f, intent);
    const prefix = ['--socket', '/tmp/cmux.sock', '--json', '--id-format', 'both'];
    const window = reservation.windowId.toLowerCase();
    expect(f.calls).toEqual([
      [...prefix, 'workspace', 'list', '--window', window],
      [
        ...prefix,
        'workspace-action',
        '--window',
        window,
        '--action',
        'set-description',
        '--workspace',
        reservation.workspaceId.toLowerCase(),
        '--description',
        intent.j1,
      ],
      [...prefix, 'workspace', 'list', '--window', window],
    ]);
    expect(JSON.stringify(f.publisher.diagnostics())).not.toContain('日本語');
  });
  it('runner bounds raw output, timeout and shell-free execution; errors never deliver', async () => {
    const execute = vi.fn((_file, _args, options, callback) => {
      expect(options).toMatchObject({
        shell: false,
        windowsHide: true,
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: DESCRIPTION_OUTPUT_BOUND,
        encoding: 'buffer',
      });
      callback(null, Buffer.from('{}'));
    });
    expect(await runDescriptionCommand('cmux', ['literal'], {}, execute as any)).toEqual({
      ok: true,
      stdout: Buffer.from('{}'),
    });
    for (const error of [
      { code: 1 },
      { code: 'ENOENT' },
      { killed: true },
      { signal: 'SIGTERM' },
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    ]) {
      expect(
        await runDescriptionCommand('cmux', [], {}, ((
          _f: unknown,
          _a: unknown,
          _o: unknown,
          cb: any,
        ) => cb(error)) as any),
      ).toEqual({
        ok: false,
      });
    }
    expect(
      await runDescriptionCommand('cmux', [], {}, (() => {
        throw new Error('spawn');
      }) as any),
    ).toEqual({ ok: false });
  });
  it('bounds an actual hung child even when it ignores SIGTERM', async () => {
    const started = Date.now();
    const result = await runDescriptionCommand(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      process.env,
    );
    expect(result).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(4000);
  });
  it.each([
    null,
    {},
    { ...set() },
    Object.freeze({ ...set(), digest: 'bad' }),
    Object.freeze({ ...set(), metrics: { ...set().metrics } }),
    Object.freeze({ kind: 'reject' }),
    Object.freeze({ kind: 'clear', metrics: set().metrics }),
  ])('ignores malformed/mutable projections %#', async (intent) => {
    const f = fake();
    expect(f.publisher.setDesired(intent)).toBe(false);
    await f.publisher.reconcile();
    expect(f.calls).toEqual([]);
  });
  it.each([
    '',
    '{',
    '{}{}',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...list(null), window_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }),
    JSON.stringify({ ...list(null), workspaces: [] }),
    JSON.stringify({
      ...list(null),
      workspaces: [...list(null).workspaces, ...list(null).workspaces],
    }),
    JSON.stringify({ ...list(null), workspaces: [{ id: reservation.workspaceId }] }),
    JSON.stringify(list(1)),
    JSON.stringify(list({})),
    JSON.stringify({ ...list(null), workspaces: {} }),
    Buffer.from([0xff]),
    ' '.repeat(DESCRIPTION_OUTPUT_BOUND + 1),
  ])('invalid read preserves unknown and stays dirty %#', async (stdout) => {
    const f = fake();
    f.runCommand.mockResolvedValue({ ok: true, stdout } as any);
    await publish(f);
    expect(f.calls).toEqual([]);
    expect(f.runCommand).toHaveBeenCalledTimes(1);
    expect(f.publisher.diagnostics()).toMatchObject({
      reservation: 'unclaimed',
      applied: 'unknown',
      dirty: true,
    });
  });
});

describe('exact description reconciliation', () => {
  it.each(['', 'foreign'])('preserves foreign strings for clear and set: %j', async (foreign) => {
    for (const intent of [clear, set()]) {
      const f = fake(foreign);
      await publish(f, intent);
      expect(f.get()).toBe(foreign);
      expect(f.publisher.diagnostics()).toMatchObject({ reservation: 'lost', applied: 'unknown' });
      const count = f.calls.length;
      f.put(null);
      await publish(f);
      expect(f.calls).toHaveLength(count);
    }
  });
  it('claims empty with clear, adopts exact bytes on restart, replaces and clears with readback', async () => {
    const f = fake();
    await publish(f, clear);
    expect(f.calls).toHaveLength(1);
    expect(f.publisher.diagnostics()).toMatchObject({
      reservation: 'held',
      applied: 'clear',
      dirty: false,
    });
    await publish(f);
    const a = f.get();
    const restarted = fake(a);
    await publish(restarted);
    expect(restarted.calls).toHaveLength(1);
    await publish(f, set('replacement'));
    expect(f.get()).toBe(set('replacement').j1);
    await publish(f, clear);
    expect(f.get()).toBeNull();
    expect(f.calls.at(-2)).not.toContain('--description');
    expect(f.publisher.diagnostics()).toMatchObject({ applied: 'clear', dirty: false });
  });
  it('an explicit failed confirmation marks even previously applied intent dirty', async () => {
    const f = fake();
    await publish(f);
    f.runCommand.mockRejectedValueOnce(new Error('read failed'));
    await f.publisher.reconcile();
    expect(f.publisher.diagnostics()).toMatchObject({
      reservation: 'held',
      applied: 'set',
      dirty: true,
    });
    await f.publisher.reconcile();
    expect(f.publisher.diagnostics()).toMatchObject({ dirty: false });
  });
  it('successful-byte dedupe still preflights a heartbeat', async () => {
    const f = fake();
    await publish(f);
    await publish(f);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.filter((args) => args.includes('set-description'))).toHaveLength(1);
  });
  it.each(['set', 'clear'])(
    'foreign write before %s preflight fences without mutation',
    async (kind) => {
      const f = fake();
      await publish(f);
      f.put('foreign');
      const count = f.calls.length;
      await publish(f, kind === 'set' ? set('replacement') : clear);
      expect(f.calls).toHaveLength(count + 1);
      expect(f.get()).toBe('foreign');
      expect(f.publisher.diagnostics().reservation).toBe('lost');
    },
  );
  it.each(['set', 'clear'])(
    'documents unavoidable foreign write between %s preflight and action',
    async (kind) => {
      const f = fake();
      await publish(f);
      const original = f.runCommand.getMockImplementation()!;
      f.runCommand.mockImplementation(async (args) => {
        if (args.includes('workspace-action')) f.put('racing foreign');
        return original(args);
      });
      await publish(f, kind === 'set' ? set('replacement') : clear);
      expect(f.get()).toBe(kind === 'set' ? set('replacement').j1 : null);
      expect(f.publisher.diagnostics()).toMatchObject({ reservation: 'held', dirty: false });
    },
  );
  it('foreign write after clear is preserved and never counted as an applied clear', async () => {
    const f = fake();
    await publish(f);
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (args) => {
      const result = await original(args);
      if (args.includes('clear-description')) f.put('foreign');
      return result;
    });
    await publish(f, clear);
    expect(f.get()).toBe('foreign');
    expect(f.publisher.diagnostics()).toMatchObject({
      reservation: 'lost',
      applied: 'set',
      dirty: true,
    });
  });
  it('foreign write between set and readback fences, without undoing it', async () => {
    const f = fake();
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (args) => {
      const result = await original(args);
      if (args.includes('set-description')) f.put('foreign');
      return result;
    });
    await publish(f);
    expect(f.get()).toBe('foreign');
    expect(f.publisher.diagnostics()).toMatchObject({ reservation: 'lost', applied: 'unknown' });
  });
  it.each(['set', 'clear'])(
    'zero-exit %s action with unchanged readback remains dirty',
    async (kind) => {
      const f = fake();
      if (kind === 'clear') await publish(f);
      const before = f.get();
      const original = f.runCommand.getMockImplementation()!;
      f.runCommand.mockImplementation(async (args) =>
        args.includes('workspace-action') ? ({ ok: true } as any) : original(args),
      );
      await publish(f, kind === 'clear' ? clear : set());
      expect(f.get()).toBe(before);
      expect(f.publisher.diagnostics()).toMatchObject({
        applied: kind === 'clear' ? 'set' : 'unknown',
        dirty: true,
      });
    },
  );
  it.each(['set', 'clear'])(
    'action success without %s readback never advances applied',
    async (kind) => {
      const f = fake();
      if (kind === 'clear') await publish(f);
      const original = f.runCommand.getMockImplementation()!;
      let acted = false;
      f.runCommand.mockImplementation(async (args) => {
        if (acted && args.includes('list')) return { ok: false } as any;
        const result = await original(args);
        if (args.includes('workspace-action')) acted = true;
        return result;
      });
      await publish(f, kind === 'clear' ? clear : set());
      expect(f.publisher.diagnostics()).toMatchObject({
        applied: kind === 'clear' ? 'set' : 'unknown',
        dirty: true,
      });
      const count = f.runCommand.mock.calls.length;
      await f.publisher.drain();
      expect(f.runCommand).toHaveBeenCalledTimes(count);
      f.runCommand.mockImplementation(original);
      await f.publisher.reconcile();
      expect(f.publisher.diagnostics()).toMatchObject({ applied: kind, dirty: false });
    },
  );
  it.each(['desired', 'applied', 'foreign'])(
    'ambiguous action retries only explicitly, then observes %s',
    async (observed) => {
      const f = fake();
      await publish(f);
      const original = f.runCommand.getMockImplementation()!;
      f.runCommand.mockImplementation(async (args) => {
        if (args.includes('set-description')) {
          if (observed !== 'applied') f.put(observed === 'desired' ? args.at(-1)! : 'foreign');
          return { ok: false } as any;
        }
        return original(args);
      });
      await publish(f, set('replacement'));
      expect(f.publisher.diagnostics()).toMatchObject({ applied: 'set', dirty: true });
      f.runCommand.mockImplementation(original);
      await f.publisher.reconcile();
      expect(f.publisher.diagnostics()).toMatchObject(
        observed === 'foreign'
          ? { reservation: 'lost', dirty: true }
          : { reservation: 'held', dirty: false },
      );
    },
  );
  it.each([
    { initial: set('A'), attempted: set('B'), latest: set('C') },
    { initial: null, attempted: set('B'), latest: set('C') },
    { initial: set('A'), attempted: clear, latest: set('C') },
    { initial: set('A'), attempted: set('B'), latest: clear },
    { initial: set('A'), attempted: set('B'), latest: set('A') },
  ])(
    'resolves ambiguous completion before applying newest queued intent %#',
    async ({ initial, attempted, latest }) => {
      const f = fake();
      if (initial) await publish(f, initial);
      const original = f.runCommand.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const actionStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let failAction = true;
      f.runCommand.mockImplementation(async (args) => {
        const result = await original(args);
        if (args.includes('workspace-action') && failAction) {
          failAction = false;
          started();
          await gate;
          return { ok: false } as any;
        }
        return result;
      });
      f.publisher.setDesired(attempted);
      const work = f.publisher.reconcile();
      await actionStarted;
      expect(f.get()).toBe(attempted.kind === 'set' ? attempted.j1 : null);
      f.publisher.setDesired(set('obsolete'));
      void f.publisher.reconcile();
      f.publisher.setDesired(latest);
      void f.publisher.reconcile();
      release();
      await work;
      expect(f.get()).toBe(latest.kind === 'set' ? latest.j1 : null);
      expect(
        f.calls
          .filter((args) => args.includes('workspace-action'))
          .map((args) => (args.includes('set-description') ? args.at(-1) : null)),
      ).toEqual([
        ...(initial ? [initial.j1] : []),
        attempted.kind === 'set' ? attempted.j1 : null,
        latest.kind === 'set' ? latest.j1 : null,
      ]);
      expect(f.publisher.diagnostics()).toMatchObject({
        reservation: 'held',
        applied: latest.kind,
        dirty: false,
        running: false,
      });
    },
  );
  it('coalesces queued work to latest only, never overlaps or self-retries', async () => {
    const f = fake();
    const original = f.runCommand.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runCommand.mockImplementationOnce(async (args) => {
      await gate;
      return original(args);
    });
    f.publisher.setDesired(set('first'));
    const work = f.publisher.reconcile();
    await Promise.resolve();
    f.publisher.setDesired(set('obsolete'));
    void f.publisher.reconcile();
    f.publisher.setDesired(set('latest'));
    void f.publisher.reconcile();
    expect(f.publisher.isIdle()).toBe(false);
    release();
    await work;
    expect(
      f.calls.filter((args) => args.includes('set-description')).map((args) => args.at(-1)),
    ).toEqual([set('first').j1, set('latest').j1]);
    expect(f.publisher.isIdle()).toBe(true);
  });
  it('shutdown joins bounded in-flight work, stops intake and never synthesizes clear', async () => {
    const f = fake();
    await publish(f);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementationOnce(async (args) => {
      await gate;
      return original(args);
    });
    f.publisher.setDesired(clear);
    void f.publisher.reconcile();
    await Promise.resolve();
    let stopped = false;
    const shutdown = f.publisher.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(f.publisher.setDesired(set())).toBe(false);
    release();
    await shutdown;
    expect(f.get()).toBe(set().j1);
    expect(f.calls.some((args) => args.includes('clear-description'))).toBe(false);
    await f.publisher.shutdown();
  });
});
