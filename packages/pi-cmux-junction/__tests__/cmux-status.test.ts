import { describe, expect, it, vi } from 'vitest';
import {
  CMUX_STATUS_TIMEOUT_MS,
  CmuxStatusPublisher,
  buildStatusArgs,
  resolveCmuxStatusExecutable,
} from '../extensions/cmux-junction/cmux-status.js';
import type { ProcessResult, ProcessRunner } from '../extensions/cmux-junction/process.js';

const success: ProcessResult = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('Junction cmux status publisher', () => {
  it('builds exact workspace-scoped argv without combining hostile tokens', () => {
    expect(
      buildStatusArgs('/tmp/socket; touch nope', 'workspace $(nope)', {
        state: 'tool-running',
        label: 'Tool running: bash',
      }),
    ).toEqual([
      '--socket',
      '/tmp/socket; touch nope',
      'set-status',
      'pi-junction',
      'Tool running: bash',
      '--workspace',
      'workspace $(nope)',
    ]);
    expect(buildStatusArgs('/tmp/socket', 'workspace', { state: null, label: null })).toEqual([
      '--socket',
      '/tmp/socket',
      'clear-status',
      'pi-junction',
      '--workspace',
      'workspace',
    ]);
  });

  it('uses only an executable nonblank bundled CLI path', async () => {
    const access = vi.fn(async () => undefined);
    await expect(
      resolveCmuxStatusExecutable({ CMUX_BUNDLED_CLI_PATH: '  /bundle/cmux  ' }, access),
    ).resolves.toBe('/bundle/cmux');
    expect(access).toHaveBeenCalledWith('/bundle/cmux', expect.any(Number));

    await expect(resolveCmuxStatusExecutable({}, access)).resolves.toBe('cmux');
    await expect(
      resolveCmuxStatusExecutable({ CMUX_BUNDLED_CLI_PATH: '/missing' }, async () => {
        throw new Error('missing');
      }),
    ).resolves.toBe('cmux');
  });

  it('passes a two-second deadline and inherited environment to the injected runner', async () => {
    const runner = vi.fn<ProcessRunner>(async () => success);
    const env = { CMUX_SOCKET_PASSWORD: 'kept-in-memory' };
    const publisher = new CmuxStatusPublisher({
      socketPath: '/tmp/cmux.sock',
      workspaceId: 'workspace-a',
      cwd: '/repo',
      env,
      runner,
      executable: async () => '/bundle/cmux',
    });

    publisher.setDesired({ state: 'thinking', label: 'Thinking' });
    await publisher.flush();

    expect(runner).toHaveBeenCalledWith(
      '/bundle/cmux',
      [
        '--socket',
        '/tmp/cmux.sock',
        'set-status',
        'pi-junction',
        'Thinking',
        '--workspace',
        'workspace-a',
      ],
      {
        cwd: '/repo',
        env,
        timeoutMs: CMUX_STATUS_TIMEOUT_MS,
        maxBufferBytes: 64 * 1024,
        shell: false,
      },
    );
  });

  it('runs one command at a time and replaces queued work with the latest desired status', async () => {
    const first = deferred<ProcessResult>();
    const calls: Array<readonly string[]> = [];
    const runner: ProcessRunner = async (_file, args) => {
      calls.push(args);
      if (calls.length === 1) return await first.promise;
      return success;
    };
    const publisher = new CmuxStatusPublisher({
      socketPath: '/tmp/cmux.sock',
      workspaceId: 'workspace-a',
      runner,
      executable: async () => 'sentinel-not-a-real-cmux',
    });

    publisher.setDesired({ state: 'thinking', label: 'Thinking' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    publisher.setDesired({ state: 'tool-running', label: 'Tool running' });
    publisher.setDesired({ state: 'error', label: 'Error' });
    expect(calls).toHaveLength(1);

    first.resolve(success);
    await publisher.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Error');
    expect(calls.flat()).not.toContain('Tool running');
  });

  it('dedupes only successful delivery and reports bounded generic failures', async () => {
    const results: ProcessResult[] = [
      { outcome: 'exit', exitCode: 7, stdout: 'private output', stderr: 'private error' },
      success,
    ];
    const runner = vi.fn<ProcessRunner>(async () => results.shift() ?? success);
    const publisher = new CmuxStatusPublisher({
      socketPath: '/tmp/cmux.sock',
      workspaceId: 'workspace-a',
      runner,
      executable: async () => 'sentinel-not-a-real-cmux',
    });

    publisher.setDesired({ state: 'idle', label: 'Idle' });
    await publisher.flush();
    expect(publisher.snapshot()).toMatchObject({
      applied: null,
      outcome: 'exit-failed',
      queueDepth: 0,
    });

    publisher.reconcile();
    await publisher.flush();
    publisher.setDesired({ state: 'idle', label: 'Idle' });
    await publisher.flush();

    expect(runner).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(publisher.snapshot())).not.toContain('private');
  });
});
