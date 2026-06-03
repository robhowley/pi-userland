import { getMergeReadyStatus } from './merge-ready.js';
import { syncMergeReadyStatusBar } from './status-bar.js';
import { selectMergeReadyBadgeId } from './status.js';
import { MERGE_READY_PULL_REQUEST_URL_EXAMPLE, validateGitHubPullRequestUrl } from './target.js';
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

const JSON_FLAG = '--json';
const URL_FLAG = '--url';
const COMMAND_USAGE = `Usage: /${MERGE_READY_COMMAND_NAME} [${URL_FLAG} <${MERGE_READY_PULL_REQUEST_URL_EXAMPLE}>] [${JSON_FLAG}]`;

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

export function registerMergeReadyCommand(pi: MergeReadyCommandAPI): void {
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

      const status = await getMergeReadyStatus({
        exec: createCommandExec(pi, ctx),
        cwd: ctx.cwd,
        ...(url === undefined ? {} : { url }),
        timeout: MERGE_READY_COMMAND_TIMEOUT_MS,
      });

      if (status.target.mode !== 'url') {
        syncMergeReadyStatusBar({
          ctx: {
            cwd: ctx.cwd,
            ui: ctx.ui,
          },
          status,
        });
      }

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
  return [URL_FLAG, JSON_FLAG]
    .filter((flag) => flag.startsWith(prefix))
    .map((flag) => ({ value: flag, label: flag }));
}

type MergeReadyParsedCommandArgs =
  | {
      ok: true;
      json: boolean;
      url?: string;
    }
  | {
      ok: false;
      message: string;
    };

function parseMergeReadyCommandArgs(args: string): MergeReadyParsedCommandArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

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
        return { ok: false, message: `Duplicate ${JSON_FLAG}. ${COMMAND_USAGE}` };
      }

      json = true;
      continue;
    }

    if (token === URL_FLAG) {
      if (url !== undefined) {
        return { ok: false, message: `Duplicate ${URL_FLAG}. ${COMMAND_USAGE}` };
      }

      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, message: `Missing value for ${URL_FLAG}. ${COMMAND_USAGE}` };
      }

      url = value;
      index += 1;
      continue;
    }

    unsupported.push(token);
  }

  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `Unsupported arguments: ${unsupported.join(' ')}. ${COMMAND_USAGE}`,
    };
  }

  return { ok: true, json, ...(url === undefined ? {} : { url }) };
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
  return `${detail.label} ${formatOpenItemDetailStatus(detail.status)}`;
}

function formatOpenItemDetailStatus(status: MergeReadyOpenItemDetail['status']): string {
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
  const identityParts: string[] = [];

  identityParts.push(`#${String(pr.number)}`);

  if (pr.title) {
    identityParts.push(pr.title);
  }

  if (identityParts.length === 0 && pr.url) {
    identityParts.push(pr.url);
  }

  return `PR: ${identityParts.join(' — ')}`;
}
