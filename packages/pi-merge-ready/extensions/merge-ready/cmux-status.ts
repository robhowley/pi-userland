import { accessSync, constants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { parseGitHubPullRequestUrl } from './target.js';
import type { MergeReadyStatus } from './types.js';

const CMUX_STATUS_KEY = 'pi-merge-ready';
const CMUX_OPERATION_TIMEOUT_MS = 2_000;

type MergeReadyCmuxSetAction = {
  kind: 'set';
  value: string;
  format?: 'markdown';
};
type MergeReadyCmuxAction = MergeReadyCmuxSetAction | { kind: 'clear' };

type MergeReadyCmuxPublisher = {
  enqueue: (action: MergeReadyCmuxAction) => void;
  shutdown: () => Promise<void>;
};

type CmuxChild = Pick<ChildProcess, 'kill' | 'once'>;
type CmuxSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; shell: false; stdio: 'ignore' },
) => CmuxChild;

type CreateMergeReadyCmuxPublisherOptions = {
  cwd: string;
  mode?: string;
  projectTrusted: boolean;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;
};

export function createMergeReadyCmuxAction(
  status: MergeReadyStatus,
  renderedStatus: string,
): MergeReadyCmuxAction {
  if (status.openItems.some((item) => item.id === 'no_pull_request')) {
    return { kind: 'clear' };
  }

  const linkedStatus = createLinkedCmuxStatus(status, renderedStatus);
  return linkedStatus === null
    ? { kind: 'set', value: renderedStatus }
    : { kind: 'set', value: linkedStatus, format: 'markdown' };
}

function createLinkedCmuxStatus(status: MergeReadyStatus, renderedStatus: string): string | null {
  const pr = status.pr;
  if (!pr) {
    return null;
  }

  const target = parseGitHubPullRequestUrl(pr.url);
  if (!target || target.prNumber !== pr.number) {
    return null;
  }

  const owner = encodeGitHubPathSegment(target.owner);
  const repo = encodeGitHubPathSegment(target.repo);
  if (owner === null || repo === null) {
    return null;
  }

  const token = ` #${String(pr.number)} `;
  const replacement = ` [PR #${String(pr.number)}](https://github.com/${owner}/${repo}/pull/${String(pr.number)}) `;
  const linkedStatus = renderedStatus.replace(token, replacement);
  return linkedStatus === renderedStatus ? null : linkedStatus;
}

function encodeGitHubPathSegment(segment: string): string | null {
  try {
    return encodeURIComponent(segment).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return null;
  }
}

export function createMergeReadyCmuxPublisher(
  options: CreateMergeReadyCmuxPublisherOptions,
): MergeReadyCmuxPublisher | null {
  const env = options.env ?? process.env;
  const workspace = env['CMUX_WORKSPACE_ID']?.trim() ?? '';
  const socket = env['CMUX_SOCKET_PATH']?.trim() ?? '';

  if (
    options.mode !== 'tui' ||
    !workspace ||
    !socket ||
    (env['CI']?.trim() ?? '') !== '' ||
    !loadCmuxEnabled(options.cwd, options.projectTrusted)
  ) {
    return null;
  }

  const command = resolveCmuxCommand(env);
  const run = options.run ?? runCmuxProcess;
  const transport = (action: MergeReadyCmuxAction) => {
    const args =
      action.kind === 'set'
        ? [
            '--socket',
            socket,
            'set-status',
            CMUX_STATUS_KEY,
            action.value,
            ...(action.format === 'markdown' ? ['--format', 'markdown'] : []),
            '--workspace',
            workspace,
          ]
        : ['--socket', socket, 'clear-status', CMUX_STATUS_KEY, '--workspace', workspace];
    return run(command, args, env);
  };

  return createSessionPublisher(transport);
}

export function createCmuxProcessRunner(
  options: {
    timeoutMs?: number;
    spawn?: CmuxSpawn;
  } = {},
): (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? CMUX_OPERATION_TIMEOUT_MS;
  const spawnProcess =
    options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));

  return (command, args, env) =>
    new Promise((resolve) => {
      let child: CmuxChild;
      let settled = false;
      const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (deadline.timer !== undefined) {
          clearTimeout(deadline.timer);
        }
        resolve();
      };

      try {
        child = spawnProcess(command, args, { env, shell: false, stdio: 'ignore' });
      } catch {
        settle();
        return;
      }

      child.once('error', settle);
      child.once('close', settle);
      deadline.timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best effort only.
        }
        settle();
      }, timeoutMs);
      deadline.timer.unref?.();
    });
}

const runCmuxProcess = createCmuxProcessRunner();

function createSessionPublisher(
  transport: (action: MergeReadyCmuxAction) => Promise<void>,
): MergeReadyCmuxPublisher {
  let active: Promise<void> | null = null;
  let pending: MergeReadyCmuxAction | null = null;
  let lastRequested: string | null = null;
  let closed = false;

  const start = (action: MergeReadyCmuxAction) => {
    active = Promise.resolve()
      .then(() => transport(action))
      .catch(() => undefined)
      .then(() => {
        active = null;
        if (!closed && pending !== null) {
          const next = pending;
          pending = null;
          start(next);
        }
      });
  };

  return {
    enqueue(action) {
      if (closed || serializeAction(action) === lastRequested) {
        return;
      }

      lastRequested = serializeAction(action);
      if (active === null) {
        start(action);
      } else {
        pending = action;
      }
    },
    async shutdown() {
      if (closed) {
        return;
      }

      closed = true;
      pending = null;
      await active;
      await Promise.resolve()
        .then(() => transport({ kind: 'clear' }))
        .catch(() => undefined);
    },
  };
}

function serializeAction(action: MergeReadyCmuxAction): string {
  return action.kind === 'clear' ? 'clear' : `set:${action.format ?? 'plain'}:${action.value}`;
}

function resolveCmuxCommand(env: NodeJS.ProcessEnv): string {
  const bundled = env['CMUX_BUNDLED_CLI_PATH']?.trim();
  if (bundled) {
    try {
      accessSync(bundled, constants.X_OK);
      return bundled;
    } catch {
      // Fall back to PATH lookup.
    }
  }

  return 'cmux';
}

function loadCmuxEnabled(cwd: string, projectTrusted: boolean): boolean {
  try {
    const settings = SettingsManager.create(cwd);
    const project = projectTrusted ? readCmuxEnabled(settings.getProjectSettings()) : undefined;
    const global = readCmuxEnabled(settings.getGlobalSettings());
    return project ?? global ?? true;
  } catch {
    return true;
  }
}

function readCmuxEnabled(settings: unknown): boolean | undefined {
  if (!isRecord(settings)) {
    return undefined;
  }

  const mergeReady = settings['pi-merge-ready'];
  if (!isRecord(mergeReady)) {
    return undefined;
  }

  const cmux = mergeReady['cmux'];
  if (!isRecord(cmux)) {
    return undefined;
  }

  return typeof cmux['enabled'] === 'boolean' ? cmux['enabled'] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
