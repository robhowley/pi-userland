import { describe, expect, it, vi } from 'vitest';
import {
  PI_SESSION_DECK_RUNTIME_ID_ENV,
  PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV,
  PI_SESSION_DECK_SESSION_FILE_ENV,
  PI_SESSION_DECK_SESSION_ID_ENV,
  collectInheritedDeckRuntimeMetadataFromEnv,
  collectRuntimeLaunchMetadataFromArgv,
  collectRuntimeProcessMetadata,
  publishDeckRuntimeEnv,
  readRuntimeProcessAncestorChain,
} from '../../extensions/session-deck/identity/runtime-signals.js';

describe('identity runtime signals', () => {
  it('sanitizes argv down to launch booleans and known mode values', () => {
    const launch = collectRuntimeLaunchMetadataFromArgv([
      'node',
      'pi',
      '--mode',
      'rpc',
      '--no-session',
      '-p',
      '--session=/tmp/private-session.md',
      '--fork',
      '/tmp/other-session.md',
      '--api-key',
      'sk-test-secret',
      'draft a secret prompt',
    ]);

    expect(launch).toEqual({
      noSession: true,
      print: true,
      mode: 'rpc',
      sessionArgPresent: true,
      forkArgPresent: true,
    });
    expect(JSON.stringify(launch)).not.toContain('/tmp/private-session.md');
    expect(JSON.stringify(launch)).not.toContain('/tmp/other-session.md');
    expect(JSON.stringify(launch)).not.toContain('sk-test-secret');
    expect(JSON.stringify(launch)).not.toContain('draft a secret prompt');
  });

  it('captures inherited deck env and publishes current deck env without retaining a null session file', () => {
    const env: NodeJS.ProcessEnv = {
      [PI_SESSION_DECK_RUNTIME_ID_ENV]: 'parent-runtime',
      [PI_SESSION_DECK_SESSION_ID_ENV]: 'parent-session',
      [PI_SESSION_DECK_SESSION_FILE_ENV]: ' /tmp/parent-session.md ',
      [PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV]: '2026-07-16T12:00:00.000Z',
    };

    expect(collectInheritedDeckRuntimeMetadataFromEnv(env)).toEqual({
      runtimeId: 'parent-runtime',
      sessionId: 'parent-session',
      sessionFile: '/tmp/parent-session.md',
      startedAt: '2026-07-16T12:00:00.000Z',
    });

    publishDeckRuntimeEnv({
      env,
      runtimeId: 'child-runtime',
      sessionId: 'child-session',
      sessionFile: null,
      startedAt: '2026-07-16T12:05:00.000Z',
    });

    expect(env[PI_SESSION_DECK_RUNTIME_ID_ENV]).toBe('child-runtime');
    expect(env[PI_SESSION_DECK_SESSION_ID_ENV]).toBe('child-session');
    expect(env[PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV]).toBe('2026-07-16T12:05:00.000Z');
    expect(env).not.toHaveProperty(PI_SESSION_DECK_SESSION_FILE_ENV);
  });

  it('bounds ancestor depth to eight entries', async () => {
    const ancestors = await readRuntimeProcessAncestorChain({
      ppid: 200,
      maxDepth: 99,
      timeoutMs: 50,
      readProcessInfo: vi.fn(async (pid: number) => ({ pid, ppid: pid + 1 })),
    });

    expect(ancestors).toHaveLength(8);
    expect(ancestors[0]).toEqual({ pid: 200, ppid: 201 });
    expect(ancestors[7]).toEqual({ pid: 207, ppid: 208 });
  });

  it('parses digit pids from ps stdout when collecting ancestors', async () => {
    const startedAt = 'Wed Jul 16 12:00:00 2026';
    const execFile = vi.fn(async () => ({ stdout: `  200   100 ${startedAt}   \n` }));

    const processMetadata = await collectRuntimeProcessMetadata({
      pid: 321,
      ppid: 200,
      now: () => new Date('2026-07-16T12:05:00.000Z'),
      uptimeSeconds: () => 5,
      maxAncestorDepth: 1,
      ancestorTimeoutMs: 50,
      execFile,
    });

    expect(execFile).toHaveBeenCalledWith('ps', ['-o', 'pid=,ppid=,lstart=', '-p', '200'], {
      timeout: 50,
    });
    expect(processMetadata).toEqual({
      pid: 321,
      ppid: 200,
      processStartedAt: '2026-07-16T12:04:55.000Z',
      ancestors: [
        {
          pid: 200,
          ppid: 100,
          processStartedAt: new Date(Date.parse(startedAt)).toISOString(),
        },
      ],
    });
  });

  it('fails open on ancestor lookup errors and keeps only the current pid/ppid', async () => {
    const processMetadata = await collectRuntimeProcessMetadata({
      pid: 321,
      ppid: 123,
      now: () => new Date('2026-07-16T12:05:00.000Z'),
      uptimeSeconds: () => 5,
      readAncestorChain: vi.fn(async () => {
        throw new Error('timed out');
      }),
    });

    expect(processMetadata).toEqual({
      pid: 321,
      ppid: 123,
      processStartedAt: '2026-07-16T12:04:55.000Z',
      ancestors: [],
    });
  });
});
