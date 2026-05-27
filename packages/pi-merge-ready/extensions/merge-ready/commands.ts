import { getMergeReadyStatus } from './merge-ready.js';
import { syncMergeReadyStatusBar } from './status-bar.js';
import { selectMergeReadyBadgeId } from './status.js';
import type { MergeReadyExec, MergeReadyExecOptions, MergeReadyExecResult } from './git.js';
import type { MergeReadyBadgeId, MergeReadyPullRequest, MergeReadyStatus } from './types.js';

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
    description: 'Show merge readiness for the current pull request',
    getArgumentCompletions: getMergeReadyCommandArgumentCompletions,
    handler: async (args, ctx) => {
      const parsedArgs = parseMergeReadyCommandArgs(args);
      if (parsedArgs.unsupported.length > 0) {
        ctx.ui.notify(`Usage: /${MERGE_READY_COMMAND_NAME} [${JSON_FLAG}]`, 'error');
        return;
      }

      const status = await getMergeReadyStatus({
        exec: createCommandExec(pi, ctx),
        cwd: ctx.cwd,
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
  const lines = [`${badge.icon} ${status.summary}`];

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
    }
  }

  return {
    message: lines.join('\n'),
    level: badge.level,
  };
}

function getMergeReadyCommandArgumentCompletions(prefix: string) {
  return JSON_FLAG.startsWith(prefix) ? [{ value: JSON_FLAG, label: JSON_FLAG }] : null;
}

function parseMergeReadyCommandArgs(args: string): { json: boolean; unsupported: string[] } {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  let json = false;
  const unsupported: string[] = [];

  for (const token of tokens) {
    if (token === JSON_FLAG) {
      json = true;
      continue;
    }

    unsupported.push(token);
  }

  return { json, unsupported };
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

function formatPullRequestIdentity(pr: MergeReadyPullRequest): string {
  const identityParts: string[] = [];

  if (pr.number !== undefined) {
    identityParts.push(`#${String(pr.number)}`);
  }

  if (pr.title) {
    identityParts.push(pr.title);
  }

  if (identityParts.length === 0 && pr.url) {
    identityParts.push(pr.url);
  }

  if (identityParts.length === 0) {
    return 'PR: unknown';
  }

  return `PR: ${identityParts.join(' — ')}`;
}
