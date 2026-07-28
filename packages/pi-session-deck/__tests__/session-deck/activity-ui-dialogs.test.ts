import { describe, expect, it, vi } from 'vitest';
import { createUiDialogMirror } from '../../extensions/session-deck/activity/ui-dialogs.js';
import type { UiDialogKind } from '../../extensions/session-deck/activity/types.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function flushRecorderTasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

async function expectResolvesBeforeNextTick<T>(promise: Promise<T>, expected: T): Promise<void> {
  const pending = Symbol('pending');
  const result = await Promise.race<T | typeof pending>([
    promise,
    new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending))),
  ]);

  expect(result).toBe(expected);
}

const DIALOG_CASES: Array<{
  kind: UiDialogKind;
  args: unknown[];
  result: unknown;
}> = [
  { kind: 'select', args: ['pick one'], result: 'selected' },
  { kind: 'input', args: [{ prompt: 'name' }], result: 'typed' },
  { kind: 'editor', args: ['draft'], result: 'edited' },
  { kind: 'confirm', args: ['Run command?', 'This needs confirmation'], result: true },
];

describe('UI dialog mirror', () => {
  it.each(DIALOG_CASES)(
    'wraps $kind and records only wait metadata',
    async ({ kind, args, result }) => {
      const recordStart = vi.fn().mockResolvedValue(undefined);
      const recordEnd = vi.fn().mockResolvedValue(undefined);
      const original = vi.fn(async () => result);
      const ui = { [kind]: original };
      const mirror = createUiDialogMirror({
        recordStart,
        recordEnd,
        clear: vi.fn().mockResolvedValue(undefined),
      });

      mirror.install(ui);

      const callDialog = ui[kind] as (...callArgs: unknown[]) => Promise<unknown>;
      await expect(callDialog(...args)).resolves.toBe(result);
      await flushRecorderTasks();

      expect(original).toHaveBeenCalledWith(...args);
      expect(recordStart).toHaveBeenCalledWith({ waitId: `${kind}-1`, kind });
      expect(recordEnd).toHaveBeenCalledWith({ waitId: `${kind}-1` });
      expect(JSON.stringify(recordStart.mock.calls)).not.toContain(String(args[0]));
    },
  );

  it('leaves non-dialog UI methods alone', () => {
    const recordStart = vi.fn().mockResolvedValue(undefined);
    const ui = {
      select: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn((_key: string, _text: string | undefined) => undefined),
    };
    const mirror = createUiDialogMirror({
      recordStart,
      recordEnd: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });

    mirror.install(ui);
    ui.setStatus('session-deck', 'ok');

    expect(ui.setStatus).toHaveBeenCalledWith('session-deck', 'ok');
    expect(recordStart).not.toHaveBeenCalled();
  });

  it('does not wait for start recording before opening prompts', async () => {
    const start = createDeferred<void>();
    const prompt = createDeferred<string>();
    const originalInput = vi.fn((_options?: unknown) => prompt.promise);
    const ui = { input: originalInput };
    const mirror = createUiDialogMirror({
      recordStart: vi.fn(() => start.promise),
      recordEnd: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    });

    mirror.install(ui);
    const result = ui.input({ prompt: 'name' }) as Promise<string>;

    expect(originalInput).toHaveBeenCalledWith({ prompt: 'name' });
    prompt.resolve('typed');
    await expectResolvesBeforeNextTick(result, 'typed');

    start.resolve(undefined);
    await flushRecorderTasks();
  });

  it('keeps overlapping dialogs of one kind on separate wait ids', async () => {
    const firstPrompt = createDeferred<string>();
    const secondPrompt = createDeferred<string>();
    const recordStart = vi.fn().mockResolvedValue(undefined);
    const recordEnd = vi.fn().mockResolvedValue(undefined);
    const ui = {
      input: vi
        .fn()
        .mockReturnValueOnce(firstPrompt.promise)
        .mockReturnValueOnce(secondPrompt.promise),
    };
    const mirror = createUiDialogMirror({
      recordStart,
      recordEnd,
      clear: vi.fn().mockResolvedValue(undefined),
    });

    mirror.install(ui);
    const firstResult = ui.input() as Promise<string>;
    const secondResult = ui.input() as Promise<string>;
    await flushRecorderTasks();

    expect(recordStart).toHaveBeenCalledTimes(2);
    expect(recordStart).toHaveBeenNthCalledWith(1, { waitId: 'input-1', kind: 'input' });
    expect(recordStart).toHaveBeenNthCalledWith(2, { waitId: 'input-2', kind: 'input' });

    firstPrompt.resolve('first');
    await expectResolvesBeforeNextTick(firstResult, 'first');
    await flushRecorderTasks();

    expect(recordEnd).toHaveBeenCalledTimes(1);
    expect(recordEnd).toHaveBeenCalledWith({ waitId: 'input-1' });

    secondPrompt.resolve('second');
    await expectResolvesBeforeNextTick(secondResult, 'second');
    await flushRecorderTasks();

    expect(recordEnd).toHaveBeenCalledTimes(2);
    expect(recordEnd).toHaveBeenNthCalledWith(2, { waitId: 'input-2' });
  });

  it('does not wait for end recording before returning prompt results', async () => {
    const end = createDeferred<void>();
    const recordEnd = vi.fn(() => end.promise);
    const ui = {
      editor: vi.fn(async () => 'edited'),
    };
    const mirror = createUiDialogMirror({
      recordStart: vi.fn().mockResolvedValue(undefined),
      recordEnd,
      clear: vi.fn().mockResolvedValue(undefined),
    });

    mirror.install(ui);
    const result = ui.editor() as Promise<string>;
    await flushRecorderTasks();

    expect(recordEnd).toHaveBeenCalledWith({ waitId: 'editor-1' });
    await expectResolvesBeforeNextTick(result, 'edited');

    end.resolve(undefined);
    await flushRecorderTasks();
  });

  it('recorder failures do not affect prompt behavior', async () => {
    const diagnostics: string[] = [];
    const ui = {
      select: vi.fn(async () => 'selected'),
    };
    const mirror = createUiDialogMirror({
      recordStart: vi.fn().mockRejectedValue(new Error('start failed')),
      recordEnd: vi.fn().mockRejectedValue(new Error('end failed')),
      clear: vi.fn().mockResolvedValue(undefined),
      onDiagnostic: (message) => diagnostics.push(message),
    });

    mirror.install(ui);

    await expect(ui.select()).resolves.toBe('selected');
    await flushRecorderTasks();

    expect(diagnostics).toEqual([
      'Failed to start select: start failed',
      'Failed to end select: end failed',
    ]);
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
    await flushRecorderTasks();
    expect(recordEnd).toHaveBeenCalledWith({ waitId: 'select-1' });
  });

  it('clears local wait ids only after shutdown clear succeeds', async () => {
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
    const result = ui.input({ prompt: 'do not record' }) as Promise<string>;
    await flushRecorderTasks();

    await mirror.clearTracked();
    deferred.resolve('typed');

    await expect(result).resolves.toBe('typed');
    await flushRecorderTasks();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(recordEnd).not.toHaveBeenCalled();
  });

  it('keeps wait ids when shutdown clear fails so prompt end can recover', async () => {
    const deferred = createDeferred<string>();
    const clearError = new Error('clear failed');
    const diagnostics: string[] = [];
    const recordEnd = vi.fn().mockResolvedValue(undefined);
    const ui = {
      input: vi.fn((_options?: unknown) => deferred.promise),
    };
    const mirror = createUiDialogMirror({
      recordStart: vi.fn().mockResolvedValue(undefined),
      recordEnd,
      clear: vi.fn().mockRejectedValue(clearError),
      onDiagnostic: (message) => diagnostics.push(message),
    });

    mirror.install(ui);
    const result = ui.input({ prompt: 'do not record' }) as Promise<string>;
    await flushRecorderTasks();

    await expect(mirror.clearTracked()).rejects.toBe(clearError);
    deferred.resolve('typed');

    await expect(result).resolves.toBe('typed');
    await flushRecorderTasks();
    expect(recordEnd).toHaveBeenCalledWith({ waitId: 'input-1' });
    expect(diagnostics).toEqual(['Failed to clear UI dialog waits: clear failed']);
  });
});
