import { runCmuxCommand, type CmuxOptions } from './cmux.js';
import { processSucceeded } from './process.js';
import type { LifecycleTarget } from './lifecycle-client.js';

const OPTIONS_WITH_VALUE = new Set([
  '--model',
  '-m',
  '--thinking',
  '--provider',
  '--extension',
  '-e',
  '--skill',
  '--mcp-config',
  '--permission-mode',
  '--session-dir',
  '--config',
  '--profile',
  '--system-prompt',
  '--append-system-prompt',
  '--cwd',
  '--dir',
  '--trust',
  '--sandbox',
]);

const OPTIONS_WITHOUT_VALUE = new Set(['--no-color', '--dangerously-skip-permissions', '--yolo']);

const SELECTORS_TO_DROP = new Set([
  '--session',
  '-s',
  '--resume',
  '--fork',
  '--api-key',
  '--prompt',
  '--print',
]);

export function hasNoSessionOption(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--no-session' || arg.startsWith('--no-session='));
}

export function buildResumeArgv(sessionId: string, argv: readonly string[]): string[] {
  const resumeArgv = ['pi', '--session', sessionId];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--') break;

    if (SELECTORS_TO_DROP.has(arg)) {
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) index += 1;
      continue;
    }
    if (
      arg.startsWith('--session=') ||
      arg.startsWith('--resume=') ||
      arg.startsWith('--fork=') ||
      arg.startsWith('--api-key=') ||
      arg.startsWith('--prompt=')
    ) {
      continue;
    }
    if (OPTIONS_WITHOUT_VALUE.has(arg)) {
      resumeArgv.push(arg);
      continue;
    }
    if ([...OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))) {
      resumeArgv.push(arg);
      continue;
    }
    if (OPTIONS_WITH_VALUE.has(arg)) {
      const value = argv[index + 1];
      if (value && !value.startsWith('-')) {
        resumeArgv.push(arg, value);
        index += 1;
      }
    }
  }

  return resumeArgv;
}

export class ResumeRuntime {
  private readonly target: LifecycleTarget;
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly argv: readonly string[];
  private readonly options: CmuxOptions;
  private started = false;
  private bindingSet = false;
  private closed = false;
  private registrationInFlight: Promise<boolean> | null = null;
  private shutdownInFlight: Promise<void> | null = null;

  constructor(options: {
    target: LifecycleTarget;
    sessionId: string;
    cwd: string;
    argv: readonly string[];
    cmux: CmuxOptions;
  }) {
    this.target = options.target;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.argv = options.argv;
    this.options = {
      ...options.cmux,
      env: {
        ...(options.cmux.env ?? process.env),
        CMUX_SOCKET_PATH: options.target.socketPath,
      },
    };
  }

  register(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.registrationInFlight) return this.registrationInFlight;
    this.registrationInFlight = this.registerNow();
    return this.registrationInFlight;
  }

  shutdown(terminationReason = 'session_shutdown'): Promise<void> {
    if (this.shutdownInFlight) return this.shutdownInFlight;
    this.closed = true;
    this.shutdownInFlight = this.shutdownNow(terminationReason);
    return this.shutdownInFlight;
  }

  private async registerNow(): Promise<boolean> {
    const started = await this.run(
      ['hooks', 'pi', 'session-start', ...this.targetArgs()],
      JSON.stringify({
        session_id: this.sessionId,
        cwd: this.cwd,
        hook_event_name: 'SessionStart',
        event: 'SessionStart',
      }),
    );
    if (!started) return false;
    this.started = true;

    const set = await this.run([
      '--json',
      'surface',
      'resume',
      'set',
      ...this.targetArgs(),
      '--name',
      'Pi',
      '--kind',
      'pi',
      '--checkpoint-id',
      this.sessionId,
      '--source',
      'agent-hook',
      '--cwd',
      this.cwd,
      '--',
      ...buildResumeArgv(this.sessionId, this.argv),
    ]);
    if (!set) return false;
    this.bindingSet = true;

    const verification = await this.runForResult([
      '--json',
      'surface',
      'resume',
      'get',
      ...this.targetArgs(),
    ]);
    return resumeBindingMatches(verification, this.sessionId);
  }

  private async shutdownNow(terminationReason: string): Promise<void> {
    await this.registrationInFlight;

    if (this.started) {
      await this.run(
        ['hooks', 'pi', 'stop', ...this.targetArgs()],
        JSON.stringify({
          session_id: this.sessionId,
          cwd: this.cwd,
          hook_event_name: 'Stop',
          event: 'Stop',
          terminationReason,
        }),
      );
    }
    if (this.bindingSet) {
      await this.run([
        '--json',
        'surface',
        'resume',
        'clear',
        ...this.targetArgs(),
        '--checkpoint-id',
        this.sessionId,
        '--source',
        'agent-hook',
      ]);
    }
  }

  private targetArgs(): string[] {
    return ['--workspace', this.target.workspaceId, '--surface', this.target.surfaceId];
  }

  private async run(args: readonly string[], input?: string): Promise<boolean> {
    return (await this.runForResult(args, input)) !== null;
  }

  private async runForResult(args: readonly string[], input?: string): Promise<string | null> {
    try {
      const result = await runCmuxCommand(this.cwd, args, this.options, input);
      return processSucceeded(result) ? result.stdout : null;
    } catch {
      return null;
    }
  }
}

function resumeBindingMatches(stdout: string | null, sessionId: string): boolean {
  if (stdout === null) return false;
  try {
    const payload: unknown = JSON.parse(stdout.trim());
    if (!isRecord(payload) || !isRecord(payload['resume_binding'])) return false;
    const binding = payload['resume_binding'];
    return binding['kind'] === 'pi' && binding['checkpoint_id'] === sessionId;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
