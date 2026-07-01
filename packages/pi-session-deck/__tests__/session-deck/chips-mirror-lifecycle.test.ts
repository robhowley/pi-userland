import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSetStatusMirror lifecycle ordering', () => {
  it('clears an in-flight write during shutdown and stops later writes until reconfigured', async () => {
    const publishGate = createDeferred<void>();
    const publishCalls: Record<string, unknown>[] = [];
    const clearCalls: Record<string, unknown>[] = [];

    vi.doMock('../../extensions/session-deck/chips/writer.js', () => ({
      writeChipRecord: vi.fn(async (input: Record<string, unknown>) => {
        publishCalls.push(input);
        await publishGate.promise;
        return '/tmp/source-a.default.session.json';
      }),
      clearChipRecord: vi.fn(async (input: Record<string, unknown>) => {
        clearCalls.push(input);
        return true;
      }),
    }));

    const { createSetStatusMirror } = await import('../../extensions/session-deck/chips/mirror.js');
    const originalSetStatus = vi.fn();
    const ui = { setStatus: originalSetStatus };
    const mirror = createSetStatusMirror();

    mirror.reconfigure({
      runtimeId: 'runtime-1',
      getSessionId: () => 'session-1',
    });
    mirror.install(ui);

    ui.setStatus('source-a', 'hello');

    await vi.waitFor(() => {
      expect(publishCalls).toHaveLength(1);
    });

    const shutdownPromise = mirror.clearTracked();
    publishGate.resolve();
    await shutdownPromise;

    expect(originalSetStatus).toHaveBeenCalledWith('source-a', 'hello');
    expect(publishCalls).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        source: 'source-a',
        text: 'hello',
        runtimeId: 'runtime-1',
        sessionId: 'session-1',
      }),
    ]);
    expect(clearCalls).toEqual([
      expect.objectContaining({
        source: 'source-a',
        chipId: 'default',
        scope: 'session',
        runtimeId: 'runtime-1',
      }),
    ]);

    ui.setStatus('source-a', 'after-shutdown');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(originalSetStatus).toHaveBeenCalledWith('source-a', 'after-shutdown');
    expect(publishCalls).toHaveLength(1);
  });
});
