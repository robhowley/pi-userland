import { execFile, type ChildProcess, type ExecFileException } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureRetryableError } from '../extensions/remembrancer/capture-jobs.js';
import {
  executeTask,
  lookupTasks,
  readTaskCatalog,
  type TaskExecutor,
} from '../extensions/remembrancer/taskwarrior.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const task = {
  uuid: '12345678-1234-1234-1234-123456789abc',
  status: 'pending',
  description: 'Send comparison',
};

it('retains every row from one validated export without public offset drift or row caps', async () => {
  let rows = Array.from({ length: 121 }, (_, index) => ({
    ...task,
    uuid: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  }));
  const execute = vi.fn<TaskExecutor>(async () => {
    const result = JSON.stringify(rows);
    // A fresh offset export would now skip the next unchanged row.
    rows = rows.slice(1);
    return result;
  });
  const signal = new AbortController().signal;
  const catalog = await readTaskCatalog(execute, { cwd: '/frozen', signal });
  expect(catalog).toHaveLength(121);
  expect(catalog[50]!['uuid']).toBe('00000000-0000-0000-0000-000000000050');
  expect(execute).toHaveBeenCalledExactlyOnceWith(['export'], undefined, {
    cwd: '/frozen',
    signal,
  });
});

it('reads a typed row over 50 KiB and an export over 1 MiB while public paging stays bounded', async () => {
  const row = { ...task, custom: 'unrelated '.repeat(150000) };
  const execute = vi.fn<TaskExecutor>(async () => JSON.stringify([row]));
  expect(await readTaskCatalog(execute)).toEqual([row]);
  await expect(lookupTasks({}, execute)).rejects.toThrow('response limit');
});

it.each([
  { rows: [{ ...task, uuid: 'short' }] },
  { rows: [{ ...task, description: null }] },
  { rows: [{ ...task, status: 'invented' }] },
  { rows: [{ ...task, annotations: [{ description: 'Missing entry' }] }] },
  { rows: [task, task] },
  { rows: { task } },
])('rejects an invalid complete catalog before discovery ($rows)', async ({ rows }) => {
  const execute: TaskExecutor = async () => JSON.stringify(rows);
  await expect(readTaskCatalog(execute)).rejects.toThrow();
});

// Exercise the real executor boundary without launching Taskwarrior.
function processResult(error: ExecFileException | null, output = '') {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(),
  }) as unknown as ChildProcess['stdin'];
  child.kill = vi.fn().mockReturnValue(true);
  vi.mocked(execFile).mockImplementationOnce(((
    _file: unknown,
    _args: unknown,
    _options: unknown,
    done: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() => {
      done(error, output, '');
      child.emit('close');
    });
    return child;
  }) as typeof execFile);
}

it('uses a finite larger executor ceiling only for the typed catalog', async () => {
  processResult(null, JSON.stringify([{ ...task, custom: 'x'.repeat(1024 * 1024) }]));
  expect(await readTaskCatalog()).toHaveLength(1);
  expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  processResult(null, '[]');
  await lookupTasks();
  expect(vi.mocked(execFile).mock.calls[1]![2]).toMatchObject({ maxBuffer: 1024 * 1024 });
});

it('preserves the executor timeout as a recognized retryable capture failure', async () => {
  processResult(
    Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGKILL' as const }),
  );
  await expect(readTaskCatalog()).rejects.toBeInstanceOf(CaptureRetryableError);
});

it.each([
  Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    killed: true,
    signal: 'SIGKILL' as const,
  }),
  Object.assign(new Error('Command failed'), { code: 1 }),
])('does not promote unrelated process failures to retryable (%s)', async (error) => {
  processResult(error);
  await expect(readTaskCatalog()).rejects.not.toBeInstanceOf(CaptureRetryableError);
});

it('does not let untyped callers raise the public executor ceiling', async () => {
  processResult(null, '[]');
  const options = { cwd: '/fixture', maxOutputBytes: Infinity, maxBuffer: Infinity };
  await executeTask(['export'], undefined, options);
  expect(vi.mocked(execFile).mock.calls[0]![2]).toMatchObject({
    cwd: '/fixture',
    maxBuffer: 1024 * 1024,
    timeout: 10000,
  });
});
