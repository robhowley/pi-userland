import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { defaultProcessRunner, processSucceeded, type ProcessRunner } from './process.js';

export const JUNCTION_STATUS_KEY = 'pi-junction';
export const CMUX_STATUS_TIMEOUT_MS = 2_000;

export interface WorkspaceStatus {
  state: string | null;
  label: string | null;
}

export type DeliveryOutcome =
  | 'delivered'
  | 'exit-failed'
  | 'timed-out'
  | 'signaled'
  | 'spawn-failed';

export interface CmuxStatusPublisherOptions {
  socketPath: string;
  workspaceId: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  executable?: () => Promise<string>;
}

type ExecutableAccess = (path: string, mode: number) => Promise<void>;

export async function resolveCmuxStatusExecutable(
  env: NodeJS.ProcessEnv,
  executableAccess: ExecutableAccess = access,
): Promise<string> {
  const bundled = env['CMUX_BUNDLED_CLI_PATH']?.trim();
  if (!bundled) return 'cmux';
  try {
    await executableAccess(bundled, constants.X_OK);
    return bundled;
  } catch {
    return 'cmux';
  }
}

export function buildStatusArgs(
  socketPath: string,
  workspaceId: string,
  status: WorkspaceStatus,
): string[] {
  if (status.label === null) {
    return [
      '--socket',
      socketPath,
      'clear-status',
      JUNCTION_STATUS_KEY,
      '--workspace',
      workspaceId,
    ];
  }
  return [
    '--socket',
    socketPath,
    'set-status',
    JUNCTION_STATUS_KEY,
    status.label,
    '--workspace',
    workspaceId,
  ];
}

function sameStatus(left: WorkspaceStatus | null, right: WorkspaceStatus | null): boolean {
  return left?.state === right?.state && left?.label === right?.label;
}

/** Serializes one command at a time and replaces queued work with the latest desired status. */
export class CmuxStatusPublisher {
  private readonly options: CmuxStatusPublisherOptions;
  private desired: WorkspaceStatus | null = null;
  private applied: WorkspaceStatus | null = null;
  private active: Promise<void> | null = null;
  private lastOutcome: DeliveryOutcome | null = null;

  constructor(options: CmuxStatusPublisherOptions) {
    this.options = options;
  }

  setApplied(status: WorkspaceStatus | null): void {
    this.applied = status === null ? null : { ...status };
  }

  setDesired(status: WorkspaceStatus): void {
    this.desired = { ...status };
    if (!this.active) this.active = this.pump().finally(() => (this.active = null));
  }

  reconcile(): void {
    if (!this.active && this.desired && !sameStatus(this.desired, this.applied)) {
      this.active = this.pump().finally(() => (this.active = null));
    }
  }

  async flush(): Promise<void> {
    while (this.active) await this.active;
  }

  snapshot(): {
    desired: WorkspaceStatus | null;
    applied: WorkspaceStatus | null;
    queueDepth: 0 | 1;
    outcome: DeliveryOutcome | null;
  } {
    return {
      desired: this.desired === null ? null : { ...this.desired },
      applied: this.applied === null ? null : { ...this.applied },
      queueDepth: this.active ? 1 : 0,
      outcome: this.lastOutcome,
    };
  }

  private async pump(): Promise<void> {
    while (this.desired && !sameStatus(this.desired, this.applied)) {
      const attempt = { ...this.desired };
      const result = await this.run(attempt);
      if (!processSucceeded(result)) {
        this.lastOutcome =
          result.outcome === 'timeout'
            ? 'timed-out'
            : result.outcome === 'signal'
              ? 'signaled'
              : result.outcome === 'spawn-failed'
                ? 'spawn-failed'
                : 'exit-failed';
        if (!sameStatus(attempt, this.desired)) continue;
        return;
      }
      this.applied = attempt;
      this.lastOutcome = 'delivered';
    }
  }

  private async run(status: WorkspaceStatus) {
    const env = this.options.env ?? process.env;
    const executable = await (this.options.executable?.() ?? resolveCmuxStatusExecutable(env));
    return await (this.options.runner ?? defaultProcessRunner)(
      executable,
      buildStatusArgs(this.options.socketPath, this.options.workspaceId, status),
      {
        cwd: this.options.cwd ?? process.cwd(),
        env,
        timeoutMs: CMUX_STATUS_TIMEOUT_MS,
        maxBufferBytes: 64 * 1024,
        shell: false,
      },
    );
  }
}
