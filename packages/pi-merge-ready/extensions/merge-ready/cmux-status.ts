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

export type MergeReadyAttentionBucket =
  | 'unknown'
  | 'ready'
  | 'waiting'
  | 'action_required'
  | 'quiet_blocked';

type MergeReadyActionReason =
  | 'merge_conflicts'
  | 'branch_out_of_date'
  | 'merge_blocked'
  | 'ci_failing'
  | 'changes_requested';

type MergeReadyPullRequestIdentity = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type MergeReadyAttention =
  | { bucket: 'unknown' }
  | {
      bucket: Exclude<MergeReadyAttentionBucket, 'unknown'>;
      identity: MergeReadyPullRequestIdentity;
      reason: MergeReadyActionReason | null;
    };

type MergeReadyNotification = {
  title: 'Merge Ready';
  subtitle: string;
  body: string;
};

type MergeReadyCmuxPublisher = {
  enqueue: (action: MergeReadyCmuxAction) => void;
  observeAttention: (status: MergeReadyStatus) => void;
  observeUnknown: () => void;
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

const ACTION_REASON_PRECEDENCE: readonly MergeReadyActionReason[] = [
  'merge_conflicts',
  'branch_out_of_date',
  'merge_blocked',
  'ci_failing',
  'changes_requested',
];

export function classifyMergeReadyAttention(status: MergeReadyStatus): MergeReadyAttention {
  const pr = status.pr;
  if (!pr || pr.lifecycle !== 'open') {
    return { bucket: 'unknown' };
  }

  const { number, url } = pr;
  if (!Number.isSafeInteger(number) || number <= 0) {
    return { bucket: 'unknown' };
  }

  const target = parseGitHubPullRequestUrl(url);
  if (!target || target.prNumber !== number) {
    return { bucket: 'unknown' };
  }

  const ids = new Set(status.openItems.map((item) => item.id));
  let bucket: Exclude<MergeReadyAttentionBucket, 'unknown'>;
  let reason: MergeReadyActionReason | null = null;
  if (ids.has('no_pull_request') || ids.has('status_ambiguous')) {
    return { bucket: 'unknown' };
  }

  reason = ACTION_REASON_PRECEDENCE.find((candidate) => ids.has(candidate)) ?? null;
  if (reason !== null) {
    bucket = 'action_required';
  } else if (ids.has('draft') || ids.has('unresolved_conversations')) {
    bucket = 'quiet_blocked';
  } else if (ids.has('ci_running') || ids.has('review_pending')) {
    bucket = 'waiting';
  } else {
    bucket = 'ready';
  }

  return {
    bucket,
    identity: { owner: target.owner, repo: target.repo, prNumber: target.prNumber },
    reason,
  };
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
  const statusTransport = (action: MergeReadyCmuxAction) => {
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
  const notificationTransport = (notification: MergeReadyNotification) =>
    run(
      command,
      [
        '--socket',
        socket,
        'notify',
        '--title',
        notification.title,
        '--subtitle',
        notification.subtitle,
        '--body',
        notification.body,
        '--workspace',
        workspace,
      ],
      env,
    );

  return createSessionPublisher(statusTransport, notificationTransport);
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
  statusTransport: (action: MergeReadyCmuxAction) => Promise<void>,
  notificationTransport: (notification: MergeReadyNotification) => Promise<void>,
): MergeReadyCmuxPublisher {
  let activeStatus: Promise<void> | null = null;
  let pendingStatus: MergeReadyCmuxAction | null = null;
  let lastRequested: string | null = null;
  let attention: MergeReadyAttention | null = null;
  let activeNotification: Promise<void> | null = null;
  const pendingNotifications: MergeReadyNotification[] = [];
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;

  const startStatus = (action: MergeReadyCmuxAction) => {
    activeStatus = Promise.resolve()
      .then(() => statusTransport(action))
      .catch(() => undefined)
      .then(() => {
        activeStatus = null;
        if (!closed && pendingStatus !== null) {
          const next = pendingStatus;
          pendingStatus = null;
          startStatus(next);
        }
      });
  };

  const startNotification = (notification: MergeReadyNotification) => {
    activeNotification = Promise.resolve()
      .then(() => notificationTransport(notification))
      .catch(() => undefined)
      .then(() => {
        activeNotification = null;
        if (!closed) {
          const next = pendingNotifications.shift();
          if (next !== undefined) {
            startNotification(next);
          }
        }
      });
  };

  const observe = (next: MergeReadyAttention) => {
    if (closed) {
      return;
    }

    const previous = attention;
    attention = next;
    if (previous === null || !samePullRequest(previous, next)) {
      return;
    }

    const notification = createAttentionNotification(previous, next);
    if (notification === null) {
      return;
    }

    if (activeNotification === null) {
      startNotification(notification);
    } else {
      pendingNotifications.push(notification);
    }
  };

  return {
    enqueue(action) {
      if (closed || serializeAction(action) === lastRequested) {
        return;
      }

      lastRequested = serializeAction(action);
      if (activeStatus === null) {
        startStatus(action);
      } else {
        pendingStatus = action;
      }
    },
    observeAttention(status) {
      observe(classifyMergeReadyAttention(status));
    },
    observeUnknown() {
      observe({ bucket: 'unknown' });
    },
    shutdown() {
      if (shutdownPromise !== null) {
        return shutdownPromise;
      }

      closed = true;
      pendingStatus = null;
      pendingNotifications.length = 0;
      shutdownPromise = Promise.all([activeStatus, activeNotification])
        .then(() => statusTransport({ kind: 'clear' }))
        .catch(() => undefined);
      return shutdownPromise;
    },
  };
}

function samePullRequest(previous: MergeReadyAttention, next: MergeReadyAttention): boolean {
  if (previous.bucket === 'unknown' || next.bucket === 'unknown') {
    return true;
  }

  return (
    previous.identity.owner === next.identity.owner &&
    previous.identity.repo === next.identity.repo &&
    previous.identity.prNumber === next.identity.prNumber
  );
}

function createAttentionNotification(
  previous: MergeReadyAttention,
  next: MergeReadyAttention,
): MergeReadyNotification | null {
  if (previous.bucket === 'unknown' || next.bucket === 'unknown') {
    return null;
  }

  const shouldNotify =
    (previous.bucket === 'ready' && next.bucket === 'action_required') ||
    (previous.bucket === 'waiting' &&
      (next.bucket === 'ready' || next.bucket === 'action_required')) ||
    (previous.bucket === 'action_required' && next.bucket === 'ready') ||
    (previous.bucket === 'quiet_blocked' && next.bucket === 'ready');
  if (!shouldNotify) {
    return null;
  }

  const identity = `${next.identity.owner}/${next.identity.repo} PR #${String(next.identity.prNumber)}`;
  return {
    title: 'Merge Ready',
    subtitle: identity,
    body: `${identity} · ${notificationBody(next)}`,
  };
}

function notificationBody(attention: Exclude<MergeReadyAttention, { bucket: 'unknown' }>): string {
  if (attention.bucket === 'ready') {
    return '✅ Ready to merge';
  }

  switch (attention.reason) {
    case 'merge_conflicts':
      return '❌ Merge conflicts need attention';
    case 'branch_out_of_date':
      return '🔄 Branch is out of date';
    case 'merge_blocked':
      return '❌ GitHub reports merge is blocked';
    case 'ci_failing':
      return '❌ Required checks are failing';
    case 'changes_requested':
      return '❌ Changes requested by reviewers';
    default:
      throw new Error('Action notification requires a reason');
  }
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
