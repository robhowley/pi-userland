import { getMergeReadyStatus } from './merge-ready.js';
import { syncMergeReadyStatusBar } from './status-bar.js';
import { selectMergeReadyBadgeId } from './status.js';
import { MERGE_READY_PULL_REQUEST_URL_EXAMPLE, validateGitHubPullRequestUrl } from './target.js';
import {
  MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS,
  MERGE_READY_WATCH_MAX_INTERVAL_SECONDS,
  MERGE_READY_WATCH_MIN_INTERVAL_SECONDS,
  MERGE_READY_WATCH_STOP_SHORTCUT_LABEL,
  parseMergeReadyWatchIntervalSeconds,
  registerMergeReadyWatchLifecycle,
  registerMergeReadyWatchShortcut,
  startMergeReadyWatch,
} from './watch.js';
import type { MergeReadyExec, MergeReadyExecOptions, MergeReadyExecResult } from './git.js';
import type {
  MergeReadyBadgeId,
  MergeReadyOpenItemDetail,
  MergeReadyPullRequest,
  MergeReadyStatus,
  MergeReadyTarget,
} from './types.js';

export const MERGE_READY_COMMAND_NAME = 'merge-ready';
export const MERGE_READY_COMMAND_TIMEOUT_MS = 20_000;

export type MergeReadyCommandNotificationLevel = 'info' | 'warning' | 'error';

export type MergeReadyCommandContext = {
  cwd: string;
  mode?: 'tui' | 'rpc' | 'json' | 'print';
  isIdle?: () => boolean;
  waitForIdle?: () => Promise<void>;
  signal?: AbortSignal;
  ui: {
    notify: (message: string, type?: MergeReadyCommandNotificationLevel) => void;
    setStatus?: (key: string, status?: string) => void;
    theme?: {
      fg: (color: string, text: string) => string;
    };
  };
};

export type MergeReadyCommandRegistration = {
  description?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) =>
    | Array<{ value: string; label: string }>
    | null
    | Promise<Array<{ value: string; label: string }> | null>;
  handler: (args: string, ctx: MergeReadyCommandContext) => Promise<void>;
};

export type MergeReadyCommandAPI = {
  registerCommand: (name: string, options: MergeReadyCommandRegistration) => void;
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
};

const WATCH_SUBCOMMAND = 'watch';
const JSON_FLAG = '--json';
const URL_FLAG = '--url';
const INTERVAL_FLAG = '--interval';

export const MERGE_READY_COMMAND_STATUS_USAGE = `Usage: /${MERGE_READY_COMMAND_NAME} [${URL_FLAG} <${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}>] [${JSON_FLAG}]`;
export const MERGE_READY_COMMAND_WATCH_USAGE = `Usage: /${MERGE_READY_COMMAND_NAME} ${WATCH_SUBCOMMAND} [${URL_FLAG} <${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}>] [${INTERVAL_FLAG} <seconds>]`;
export const MERGE_READY_COMMAND_USAGE = `${MERGE_READY_COMMAND_STATUS_USAGE}\n${MERGE_READY_COMMAND_WATCH_USAGE}`;

const BADGE_PRESENTATION: Record<
  MergeReadyBadgeId,
  {
    icon: string;
    level: MergeReadyCommandNotificationLevel;
  }
> = {
  draft: { icon: '📝', level: 'warning' },
  merge_conflicts: { icon: '⚠️', level: 'error' },
  branch_out_of_date: { icon: '🔄', level: 'warning' },
  merge_blocked: { icon: '⛔', level: 'error' },
  ci_failing: { icon: '❌', level: 'error' },
  changes_requested: { icon: '🔁', level: 'error' },
  unresolved_conversations: { icon: '💬', level: 'error' },
  ci_running: { icon: '⏳', level: 'warning' },
  review_pending: { icon: '👀', level: 'warning' },
  ready: { icon: '✅', level: 'info' },
  merged: { icon: '✅', level: 'info' },
  closed: { icon: '⛔', level: 'warning' },
  unknown: { icon: '❔', level: 'warning' },
};

type MergeReadyCommandWatchRuntimeAPI = MergeReadyCommandAPI & {
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ) => Promise<void> | void;
  on?: (
    event: 'session_shutdown' | 'agent_end',
    handler: (event: unknown, ctx: unknown) => void | Promise<void>,
  ) => void;
  registerShortcut?: (
    shortcut: string,
    options: {
      description?: string;
      handler: (ctx: {
        isIdle: () => boolean;
        hasPendingMessages: () => boolean;
        abort: () => void;
      }) => Promise<void> | void;
    },
  ) => void;
};

export function registerMergeReadyCommand(pi: MergeReadyCommandAPI): void {
  const watchPi = pi as MergeReadyCommandWatchRuntimeAPI;
  registerMergeReadyWatchLifecycle(watchPi);
  registerMergeReadyWatchShortcut(watchPi);

  pi.registerCommand(MERGE_READY_COMMAND_NAME, {
    description: 'Show merge readiness for the current pull request or an explicit GitHub PR URL',
    getArgumentCompletions: getMergeReadyCommandArgumentCompletions,
    handler: async (args, ctx) => {
      const parsedArgs = parseMergeReadyCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.message, 'error');
        return;
      }

      let url: string | undefined;
      if (parsedArgs.url !== undefined) {
        const validation = validateGitHubPullRequestUrl(parsedArgs.url);
        if (!validation.ok) {
          ctx.ui.notify(`Invalid ${URL_FLAG}: ${validation.message}`, 'error');
          return;
        }

        url = validation.target.url;
      }

      const exec = createCommandExec(pi, ctx);

      if (parsedArgs.mode === 'watch') {
        if (ctx.mode !== undefined && ctx.mode !== 'tui') {
          ctx.ui.notify(
            `Merge-ready watch currently requires TUI mode because stop is provided via the ${MERGE_READY_WATCH_STOP_SHORTCUT_LABEL} shortcut.`,
            'error',
          );
          return;
        }

        const started = startMergeReadyWatch({
          api: watchPi,
          ctx,
          exec,
          intervalSeconds: parsedArgs.intervalSeconds,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
          ...(url === undefined ? {} : { url }),
        });
        ctx.ui.notify(started.message, started.level);
        if (started.ok) {
          await started.promise;
        }
        return;
      }

      const status = await getMergeReadyStatus({
        exec,
        cwd: ctx.cwd,
        ...(url === undefined ? {} : { url }),
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      });

      syncMergeReadyStatusBar({
        ctx: {
          cwd: ctx.cwd,
          ui: ctx.ui,
        },
        status,
      });

      if (parsedArgs.json) {
        ctx.ui.notify(JSON.stringify(status, null, 2), 'info');
        return;
      }

      const rendered = renderMergeReadyStatus(status);
      ctx.ui.notify(rendered.message, rendered.level);
    },
  });
}

export function renderMergeReadyStatus(status: MergeReadyStatus): {
  message: string;
  level: MergeReadyCommandNotificationLevel;
} {
  const badgeId = selectMergeReadyBadgeId(status);
  const badge = BADGE_PRESENTATION[badgeId];
  const lines = [`${badge.icon} ${status.summary}`, `Target: ${formatTarget(status.target)}`];

  if (status.pr) {
    lines.push(formatPullRequestIdentity(status.pr));
  }

  lines.push(`State: ${status.state}`);

  if (status.openItems.length === 0) {
    lines.push('Open items: none');
  } else {
    lines.push('Open items:');
    for (const openItem of status.openItems) {
      lines.push(`- ${openItem.summary}`);
      for (const detail of openItem.details ?? []) {
        lines.push(`  - ${formatOpenItemDetail(detail)}`);
      }
    }
  }

  return {
    message: lines.join('\n'),
    level: badge.level,
  };
}

function getMergeReadyCommandArgumentCompletions(prefix: string) {
  return [WATCH_SUBCOMMAND, URL_FLAG, JSON_FLAG, INTERVAL_FLAG]
    .filter((flag) => flag.startsWith(prefix))
    .map((flag) => ({ value: flag, label: flag }));
}

export type MergeReadyParsedCommandArgs =
  | {
      ok: true;
      mode: 'status';
      json: boolean;
      url?: string;
    }
  | {
      ok: true;
      mode: 'watch';
      intervalSeconds: number;
      url?: string;
    }
  | {
      ok: false;
      message: string;
    };

export function parseMergeReadyCommandArgs(args: string): MergeReadyParsedCommandArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens[0] === WATCH_SUBCOMMAND) {
    return parseMergeReadyWatchCommandArgs(tokens.slice(1));
  }

  return parseMergeReadyStatusCommandArgs(tokens);
}

function parseMergeReadyStatusCommandArgs(tokens: string[]): MergeReadyParsedCommandArgs {
  let json = false;
  let url: string | undefined;
  const unsupported: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    if (token === JSON_FLAG) {
      if (json) {
        return createCommandUsageError(`Duplicate ${JSON_FLAG}`);
      }

      json = true;
      continue;
    }

    if (token === URL_FLAG) {
      if (url !== undefined) {
        return createCommandUsageError(`Duplicate ${URL_FLAG}`);
      }

      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) {
        return createCommandUsageError(`Missing value for ${URL_FLAG}`);
      }

      url = value;
      index += 1;
      continue;
    }

    unsupported.push(token);
  }

  if (unsupported.length > 0) {
    return createCommandUsageError(`Unsupported arguments: ${unsupported.join(' ')}`);
  }

  return { ok: true, mode: 'status', json, ...(url === undefined ? {} : { url }) };
}

function parseMergeReadyWatchCommandArgs(tokens: string[]): MergeReadyParsedCommandArgs {
  let intervalSeconds = MERGE_READY_WATCH_DEFAULT_INTERVAL_SECONDS;
  let url: string | undefined;
  let hasInterval = false;
  const unsupported: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    if (token === JSON_FLAG) {
      return createCommandUsageError(`The ${JSON_FLAG} flag is not supported in watch mode`);
    }

    if (token === URL_FLAG) {
      if (url !== undefined) {
        return createCommandUsageError(`Duplicate ${URL_FLAG}`);
      }

      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) {
        return createCommandUsageError(`Missing value for ${URL_FLAG}`);
      }

      url = value;
      index += 1;
      continue;
    }

    if (token === INTERVAL_FLAG) {
      if (hasInterval) {
        return createCommandUsageError(`Duplicate ${INTERVAL_FLAG}`);
      }

      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) {
        return createCommandUsageError(`Missing value for ${INTERVAL_FLAG}`);
      }

      const parsedIntervalSeconds = parseMergeReadyWatchIntervalSeconds(value);
      if (!parsedIntervalSeconds.ok) {
        if (parsedIntervalSeconds.message === 'Watch interval must be a whole number of seconds.') {
          return createCommandUsageError(
            `Invalid value for ${INTERVAL_FLAG}: ${JSON.stringify(value)}. Expected a positive integer number of seconds`,
          );
        }

        if (
          parsedIntervalSeconds.message ===
          `Watch interval must be at least ${String(MERGE_READY_WATCH_MIN_INTERVAL_SECONDS)} seconds.`
        ) {
          return createCommandUsageError(
            `${INTERVAL_FLAG} must be at least ${String(MERGE_READY_WATCH_MIN_INTERVAL_SECONDS)} seconds`,
          );
        }

        if (
          parsedIntervalSeconds.message ===
          `Watch interval must be at most ${String(MERGE_READY_WATCH_MAX_INTERVAL_SECONDS)} seconds.`
        ) {
          return createCommandUsageError(
            `${INTERVAL_FLAG} must be at most ${String(MERGE_READY_WATCH_MAX_INTERVAL_SECONDS)} seconds`,
          );
        }

        return createCommandUsageError(parsedIntervalSeconds.message);
      }

      intervalSeconds = parsedIntervalSeconds.value;
      hasInterval = true;
      index += 1;
      continue;
    }

    unsupported.push(token);
  }

  if (unsupported.length > 0) {
    return createCommandUsageError(`Unsupported arguments: ${unsupported.join(' ')}`);
  }

  return {
    ok: true,
    mode: 'watch',
    intervalSeconds,
    ...(url === undefined ? {} : { url }),
  };
}

function createCommandUsageError(message: string): MergeReadyParsedCommandArgs {
  return {
    ok: false,
    message: `${message}. ${MERGE_READY_COMMAND_USAGE}`,
  };
}

function createCommandExec(
  pi: MergeReadyCommandAPI,
  ctx: MergeReadyCommandContext,
): MergeReadyExec {
  return async (
    command: string,
    args: string[],
    options?: MergeReadyExecOptions,
  ): Promise<MergeReadyExecResult> => {
    const execOptions: { cwd?: string; timeout?: number } = {
      cwd: options?.cwd ?? ctx.cwd,
    };

    if (options?.timeout !== undefined) {
      execOptions.timeout = options.timeout;
    }

    return pi.exec(command, args, execOptions);
  };
}

function formatOpenItemDetail(detail: MergeReadyOpenItemDetail): string {
  let formatted = detail.label;

  if (detail.status) {
    formatted = `${formatted} ${formatOpenItemDetailStatus(detail.status)}`;
  }

  if (detail.url) {
    formatted = `${formatted} — ${detail.url}`;
  }

  return formatted;
}

function formatOpenItemDetailStatus(
  status: NonNullable<MergeReadyOpenItemDetail['status']>,
): string {
  if (status === 'failing') {
    return '❌';
  }

  if (status === 'running') {
    return '⏳';
  }

  return '❔';
}

function formatTarget(target: MergeReadyTarget): string {
  if (target.mode === 'url') {
    return target.url;
  }

  const branch = target.branch ? `current branch ${target.branch}` : 'current branch';
  if (target.owner && target.repo) {
    return `${branch} (${target.owner}/${target.repo})`;
  }

  return branch;
}

function formatPullRequestIdentity(pr: MergeReadyPullRequest): string {
  if (pr.title) {
    return `PR: #${String(pr.number)} — ${pr.title}`;
  }

  return `PR: #${String(pr.number)}`;
}
