import { describe, expect, it, vi } from 'vitest';
import { createUiDialogMirror } from '../../extensions/session-deck/activity/ui-dialogs.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe('UI dialog mirror', () => {
  it('wraps only select, input, and editor and records around the awaited call', async () => {
    const calls: string[] = [];
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    const ui = {
      select: vi.fn(async (prompt: string) => {
        calls.push(`select:${prompt}`);
        return 'selected';
      }),
      input: vi.fn(async () => {
        calls.push('input');
        return 'typed';
      }),
      editor: vi.fn(async () => {
        calls.push('editor');
        return 'edited';
      }),
      setStatus: vi.fn((_key: string, _text: string | undefined) => {
        calls.push('status');
      }),
    };

    const mirror = createUiDialogMirror({
      recordStart: vi.fn(async (event) => {
        starts.push(event);
        calls.push(`start:${event.kind}`);
      }),
      recordEnd: vi.fn(async (event) => {
        ends.push(event);
        calls.push(`end:${event.waitId}`);
      }),
      clear: vi.fn().mockResolvedValue(undefined),
    });

    mirror.install(ui);

    await expect(ui.select('do not record this prompt')).resolves.toBe('selected');
    ui.setStatus('session-deck', 'ok');

    expect(calls).toEqual([
      'start:select',
      'select:do not record this prompt',
      'end:select-1',
      'status',
    ]);
    expect(starts).toEqual([{ waitId: 'select-1', kind: 'select' }]);
    expect(ends).toEqual([{ waitId: 'select-1' }]);
    expect(JSON.stringify(starts)).not.toContain('do not record this prompt');
  });

  it('clears in finally and preserves original rejection identity', async () => {
    const error = new Error('cancelled');
    const recordEnd = vi.fn().mockResolvedValue(undefined);
    const ui = {
      select: vi.fn(async () => {
        throw error;
      }),
    };
    const mirror = createUiDialogMirror({
      recordStart: vi.fn().mockResolvedValue(undefined),
      recordEnd,
      clear: vi.fn().mockResolvedValue(undefined),
    });

    mirror.install(ui);

    await expect(ui.select()).rejects.toBe(error);
    expect(recordEnd).toHaveBeenCalledWith({ waitId: 'select-1' });
  });

  it('uses tracked wait ids so shutdown clear prevents late end writes', async () => {
    const deferred = createDeferred<string>();
    const recordEnd = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    const ui = {
      input: vi.fn((_options?: unknown) => deferred.promise),
    };
    const mirror = createUiDialogMirror({
      recordStart: vi.fn().mockResolvedValue(undefined),
      recordEnd,
      clear,
    });

    mirror.install(ui);
    const result = ui.input({ prompt: 'do not record' });
    await Promise.resolve();

    await mirror.clearTracked();
    deferred.resolve('typed');

    await expect(result).resolves.toBe('typed');
    expect(clear).toHaveBeenCalledTimes(1);
    expect(recordEnd).not.toHaveBeenCalled();
  });
});
