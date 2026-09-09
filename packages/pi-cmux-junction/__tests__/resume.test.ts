import { describe, expect, it, vi } from 'vitest';
import {
  buildResumeArgv,
  hasNoSessionOption,
  ResumeRuntime,
} from '../extensions/cmux-junction/resume.js';
import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
} from '../extensions/cmux-junction/process.js';

const target = {
  socketPath: '/tmp/live.sock',
  workspaceId: 'workspace-live',
  surfaceId: 'surface-live',
};

const success = (stdout = ''): ProcessResult => ({
  outcome: 'exit',
  exitCode: 0,
  stdout,
  stderr: '',
});

function runtime(runner: ProcessRunner, argv: readonly string[] = ['pi']) {
  return new ResumeRuntime({
    target,
    sessionId: 'session-owned',
    cwd: '/repo',
    argv,
    cmux: {
      runner,
      env: { CMUX_SOCKET_PATH: '/tmp/stale.sock', CMUX_BUNDLED_CLI_PATH: '' },
      timeoutMs: 321,
    },
  });
}

describe('resume argv boundary', () => {
  it('forces the persisted session and keeps only replay-safe Pi options', () => {
    expect(
      buildResumeArgv('session-new', [
        '/usr/bin/node',
        '/package/pi/cli.js',
        '--session',
        'session-old',
        '--resume=latest',
        '--fork',
        '/private/old.jsonl',
        '--api-key',
        'secret',
        '--prompt=private',
        '--print',
        'private prompt',
        '--no-session',
        '--unknown',
        'unknown-value',
        '--model',
        'anthropic/claude',
        '--thinking=high',
        '--provider',
        'openai',
        '--config',
        'config.json',
        '--system-prompt',
        'safe; $(not-a-shell)',
        '--no-color',
        '--yolo',
        'positional prompt',
      ]),
    ).toEqual([
      'pi',
      '--session',
      'session-new',
      '--model',
      'anthropic/claude',
      '--thinking=high',
      '--provider',
      'openai',
      '--config',
      'config.json',
      '--system-prompt',
      'safe; $(not-a-shell)',
      '--no-color',
      '--yolo',
    ]);
  });

  it.each([
    ['--tools', 'read,write'],
    ['-t', 'read,write'],
    ['--exclude-tools', 'bash,subagent'],
    ['-xt', 'bash,subagent'],
  ])('preserves %s with its complete following value', (option, value) => {
    expect(buildResumeArgv('session-tools', ['pi', option, value])).toEqual([
      'pi',
      '--session',
      'session-tools',
      option,
      value,
    ]);
  });

  it.each(['--no-tools', '-nt', '--no-builtin-tools', '-nbt'])(
    'preserves restrictive option %s',
    (option) => {
      expect(buildResumeArgv('session-tools', ['pi', option])).toEqual([
        'pi',
        '--session',
        'session-tools',
        option,
      ]);
    },
  );

  it('preserves tool options in original order and rejects unsupported equals forms', () => {
    expect(
      buildResumeArgv('session-tools', [
        'pi',
        '--no-tools',
        '--tools',
        'read,write',
        '-nbt',
        '--exclude-tools',
        'bash',
        '-nt',
        '-t',
        'edit',
        '-xt',
        'subagent',
        '--tools=read',
        '-t=read',
        '--exclude-tools=bash',
        '-xt=bash',
        '--unknown',
        'unknown-value',
      ]),
    ).toEqual([
      'pi',
      '--session',
      'session-tools',
      '--no-tools',
      '--tools',
      'read,write',
      '-nbt',
      '--exclude-tools',
      'bash',
      '-nt',
      '-t',
      'edit',
      '-xt',
      'subagent',
    ]);
  });

  it('drops incomplete tool values while preserving following restrictive options', () => {
    expect(
      buildResumeArgv('session-tools', [
        'pi',
        '--tools',
        '--no-tools',
        '-t',
        '--no-builtin-tools',
        '--exclude-tools',
        '-nt',
        '-xt',
        '-nbt',
      ]),
    ).toEqual([
      'pi',
      '--session',
      'session-tools',
      '--no-tools',
      '--no-builtin-tools',
      '-nt',
      '-nbt',
    ]);
  });

  it('preserves an empty tool list value', () => {
    expect(buildResumeArgv('session-tools', ['pi', '--tools', ''])).toEqual([
      'pi',
      '--session',
      'session-tools',
      '--tools',
      '',
    ]);
  });

  it('drops incomplete value options and detects no-session forms', () => {
    expect(buildResumeArgv('session-a', ['pi', '--model', '--yolo', '--cwd'])).toEqual([
      'pi',
      '--session',
      'session-a',
      '--yolo',
    ]);
    expect(hasNoSessionOption(['pi', '--no-session'])).toBe(true);
    expect(hasNoSessionOption(['pi', '--no-session=true'])).toBe(true);
    expect(hasNoSessionOption(['pi', '--model', 'x'])).toBe(false);
    expect(buildResumeArgv('session-a', ['pi', '--', '--model', 'prompt text'])).toEqual([
      'pi',
      '--session',
      'session-a',
    ]);
  });
});

describe('resume registration', () => {
  it('runs managed start, set, and verified get in order on the resolved target', async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: ProcessOptions }> = [];
    const runner: ProcessRunner = async (file, args, options) => {
      calls.push({ file, args, options });
      return calls.length === 3
        ? success(
            JSON.stringify({
              resume_binding: { kind: 'pi', checkpoint_id: 'session-owned' },
            }),
          )
        : success();
    };
    const registration = runtime(runner, ['pi', '--session', 'old', '--model', 'safe-model']);

    await expect(registration.register()).resolves.toBe(true);

    expect(calls.map(({ args }) => args)).toEqual([
      [
        'hooks',
        'pi',
        'session-start',
        '--workspace',
        'workspace-live',
        '--surface',
        'surface-live',
      ],
      [
        '--json',
        'surface',
        'resume',
        'set',
        '--workspace',
        'workspace-live',
        '--surface',
        'surface-live',
        '--name',
        'Pi',
        '--kind',
        'pi',
        '--checkpoint-id',
        'session-owned',
        '--source',
        'agent-hook',
        '--cwd',
        '/repo',
        '--',
        'pi',
        '--session',
        'session-owned',
        '--model',
        'safe-model',
      ],
      [
        '--json',
        'surface',
        'resume',
        'get',
        '--workspace',
        'workspace-live',
        '--surface',
        'surface-live',
      ],
    ]);
    expect(calls.every(({ file }) => file === 'cmux')).toBe(true);
    expect(calls.every(({ options }) => options.shell === false)).toBe(true);
    expect(calls.every(({ options }) => options.timeoutMs === 321)).toBe(true);
    expect(
      calls.every(({ options }) => options.env?.['CMUX_SOCKET_PATH'] === '/tmp/live.sock'),
    ).toBe(true);
    expect(JSON.parse(calls[0]!.options.input!)).toEqual({
      session_id: 'session-owned',
      cwd: '/repo',
      hook_event_name: 'SessionStart',
      event: 'SessionStart',
    });
  });

  it.each([
    ['malformed JSON', 'not-json'],
    ['missing binding', '{}'],
    ['wrong kind', '{"resume_binding":{"kind":"other","checkpoint_id":"session-owned"}}'],
    ['wrong checkpoint', '{"resume_binding":{"kind":"pi","checkpoint_id":"sibling"}}'],
  ])('rejects %s verification and retains guarded cleanup ownership', async (_name, stdout) => {
    const calls: readonly string[][] = [];
    const runner: ProcessRunner = async (_file, args) => {
      (calls as string[][]).push([...args]);
      return calls.length === 3 ? success(stdout) : success();
    };
    const registration = runtime(runner);

    await expect(registration.register()).resolves.toBe(false);
    await expect(registration.shutdown()).resolves.toBeUndefined();

    expect(calls.at(-1)).toEqual([
      '--json',
      'surface',
      'resume',
      'clear',
      '--workspace',
      'workspace-live',
      '--surface',
      'surface-live',
      '--checkpoint-id',
      'session-owned',
      '--source',
      'agent-hook',
    ]);
  });

  it.each([
    [
      'nonzero',
      async (): Promise<ProcessResult> => ({
        outcome: 'exit',
        exitCode: 1,
        stdout: '',
        stderr: 'unsupported',
      }),
    ],
    [
      'timeout',
      async (): Promise<ProcessResult> => ({
        outcome: 'timeout',
        timeoutMs: 321,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      }),
    ],
    [
      'signal',
      async (): Promise<ProcessResult> => ({
        outcome: 'signal',
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      }),
    ],
    [
      'runner exception',
      async (): Promise<ProcessResult> => {
        throw new Error('unavailable');
      },
    ],
  ])('fails open when managed start has a %s result', async (_name, runner) => {
    await expect(runtime(vi.fn(runner)).register()).resolves.toBe(false);
  });

  it('sends stop before checkpoint-scoped clear and never clears a sibling', async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: ProcessRunner = async (_file, args, options) => {
      calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
      return calls.length === 3
        ? success(
            JSON.stringify({
              resume_binding: { kind: 'pi', checkpoint_id: 'session-owned' },
            }),
          )
        : success();
    };
    const registration = runtime(runner);
    await registration.register();

    await registration.shutdown('fork');
    await registration.shutdown('quit');

    expect(calls.slice(3).map(({ args }) => args.slice(0, 4))).toEqual([
      ['hooks', 'pi', 'stop', '--workspace'],
      ['--json', 'surface', 'resume', 'clear'],
    ]);
    expect(JSON.parse(calls[3]!.input!)).toMatchObject({
      session_id: 'session-owned',
      terminationReason: 'fork',
    });
    expect(calls[4]!.args).toContain('session-owned');
    expect(calls[4]!.args).not.toContain('sibling');
  });

  it('waits for in-flight registration before overlapping shutdown cleanup', async () => {
    let releaseStart!: () => void;
    const commands: string[][] = [];
    const runner: ProcessRunner = async (_file, args) => {
      commands.push([...args]);
      if (commands.length === 1) {
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
      }
      return args.includes('get')
        ? success(
            JSON.stringify({
              resume_binding: { kind: 'pi', checkpoint_id: 'session-owned' },
            }),
          )
        : success();
    };
    const registration = runtime(runner);

    const registering = registration.register();
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const shutdown = registration.shutdown();
    expect(registration.shutdown()).toBe(shutdown);
    releaseStart();

    await expect(registering).resolves.toBe(true);
    await expect(shutdown).resolves.toBeUndefined();
    expect(commands.map((args) => args.slice(0, 4))).toEqual([
      ['hooks', 'pi', 'session-start', '--workspace'],
      ['--json', 'surface', 'resume', 'set'],
      ['--json', 'surface', 'resume', 'get'],
      ['hooks', 'pi', 'stop', '--workspace'],
      ['--json', 'surface', 'resume', 'clear'],
    ]);
  });

  it('still clears an owned binding when the final hook fails', async () => {
    let call = 0;
    const runner = vi.fn<ProcessRunner>(async () => {
      call += 1;
      if (call === 3) {
        return success(
          JSON.stringify({ resume_binding: { kind: 'pi', checkpoint_id: 'session-owned' } }),
        );
      }
      if (call === 4) throw new Error('stop failed');
      return success();
    });
    const registration = runtime(runner);
    await registration.register();

    await expect(registration.shutdown()).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(5);
    expect(runner.mock.calls[4]?.[1]).toContain('clear');
  });

  it('does not clear when set never established ownership', async () => {
    const runner = vi.fn<ProcessRunner>(async (_file, args) =>
      args.includes('set')
        ? { outcome: 'exit', exitCode: 1, stdout: '', stderr: 'rejected' }
        : success(),
    );
    const registration = runtime(runner);

    await expect(registration.register()).resolves.toBe(false);
    await registration.shutdown();

    expect(runner.mock.calls.map((call) => call[1])).toHaveLength(3);
    expect(runner.mock.calls.map((call) => call[1]).some((args) => args.includes('clear'))).toBe(
      false,
    );
  });
});
