import { type MergeReadyCommandAPI } from './commands.js';
import {
  type MergeReadyExec,
  type MergeReadyExecOptions,
  type MergeReadyExecResult,
} from './git.js';
import { getMergeReadyStatus } from './merge-ready.js';
import { selectMergeReadyBadgeId } from './status.js';
import type { MergeReadyBadgeId, MergeReadyStatus } from './types.js';

export const MERGE_READY_STATUS_BAR_KEY = 'merge-ready';
export const MERGE_READY_STATUS_BAR_TIMEOUT_MS = 8_000;
export const MERGE_READY_STATUS_BAR_TTL_MS = 60_000;

export type MergeReadyStatusBarEventName = 'session_start' | 'turn_end';

export type MergeReadyStatusBarContext = {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    setStatus: (key: string, status?: string) => void;
    theme?: {
      fg: (color: string, text: string) => string;
    };
  };
};

export type MergeReadyStatusBarAPI = Pick<MergeReadyCommandAPI, 'exec'> & {
  on: (
    event: MergeReadyStatusBarEventName,
    handler: (event: unknown, ctx: MergeReadyStatusBarContext) => void | Promise<void>,
  ) => void;
};

export type MergeReadyStatusBarRefreshOptions = {
  exec: MergeReadyExec;
  ctx: MergeReadyStatusBarContext;
  force?: boolean;
  now?: number | Date;
  timeout?: number;
};

export type MergeReadyStatusBarRefreshResult = {
  text: string;
  cached: boolean;
};

type MergeReadyStatusBarCacheEntry = {
  cwd: string;
  text: string;
  refreshedAtMs: number;
};

const STATUS_BAR_PREFIX = '';
const UNKNOWN_STATUS_BAR_TEXT = '❔ Unknown';
const BADGE_PRESENTATION: Record<MergeReadyBadgeId, { icon: string; text: string }> = {
  draft: { icon: '📝', text: 'Draft' },
  merge_conflicts: { icon: '⚠️', text: 'Conflicts' },
  branch_out_of_date: { icon: '🔄', text: 'Out of date' },
  merge_blocked: { icon: '⛔', text: 'Merge blocked' },
  ci_failing: { icon: '❌', text: 'Checks failing' },
  changes_requested: { icon: '🔁', text: 'Changes requested' },
  unresolved_conversations: { icon: '💬', text: 'Conversations open' },
  ci_running: { icon: '⏳', text: 'Checks running' },
  review_pending: { icon: '👀', text: 'Review pending' },
  ready: { icon: '✅', text: 'Ready' },
  merged: { icon: '✅', text: 'Merged' },
  closed: { icon: '⛔', text: 'Closed' },
  unknown: { icon: '❔', text: 'Unknown' },
};
const SUMMARY_TEXT: Record<string, string> = {
  'Ready to merge': 'Ready',
  'Merge conflicts detected': 'Conflicts',
  'Branch is out of date with base': 'Out of date',
  'GitHub reports merge is blocked': 'Merge blocked',
  'Pull request is still a draft': 'Draft',
  'Required checks are failing': 'Checks failing',
  'Changes requested by reviewers': 'Changes requested',
  'Unresolved review conversations remain': 'Conversations open',
  'Checks are still running': 'Checks running',
  'Waiting for review': 'Review pending',
  'Pull request merged': 'Merged',
  'Pull request closed': 'Closed',
  'No pull request found': 'No PR',
  'Merge readiness is ambiguous': 'Unknown',
};

let statusBarCache: MergeReadyStatusBarCacheEntry | null = null;

export function registerMergeReadyStatusBar(pi: MergeReadyStatusBarAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    await refreshMergeReadyStatusBar({
      exec: createStatusBarExec(pi, ctx),
      ctx,
      force: true,
    });
  });

  pi.on('turn_end', async (_event, ctx) => {
    await refreshMergeReadyStatusBar({
      exec: createStatusBarExec(pi, ctx),
      ctx,
    });
  });
}

export async function refreshMergeReadyStatusBar(
  options: MergeReadyStatusBarRefreshOptions,
): Promise<MergeReadyStatusBarRefreshResult | null> {
  if (options.ctx.hasUI === false) {
    return null;
  }

  const nowMs = resolveNowMs(options.now);
  const cachedEntry = statusBarCache;

  if (
    !options.force &&
    cachedEntry &&
    cachedEntry.cwd === options.ctx.cwd &&
    nowMs - cachedEntry.refreshedAtMs < MERGE_READY_STATUS_BAR_TTL_MS
  ) {
    options.ctx.ui?.setStatus(
      MERGE_READY_STATUS_BAR_KEY,
      options.ctx.ui?.theme?.fg('dim', cachedEntry.text) ?? cachedEntry.text,
    );
    return {
      text: cachedEntry.text,
      cached: true,
    };
  }

  const text = await loadMergeReadyStatusBarText({
    exec: options.exec,
    cwd: options.ctx.cwd,
    timeout: options.timeout ?? MERGE_READY_STATUS_BAR_TIMEOUT_MS,
  });

  statusBarCache = {
    cwd: options.ctx.cwd,
    text,
    refreshedAtMs: nowMs,
  };

  options.ctx.ui?.setStatus(
    MERGE_READY_STATUS_BAR_KEY,
    options.ctx.ui?.theme?.fg('dim', text) ?? text,
  );

  return {
    text,
    cached: false,
  };
}

export function renderMergeReadyStatusBar(status: MergeReadyStatus): string {
  const badgeId = selectMergeReadyBadgeId(status);
  const badge = BADGE_PRESENTATION[badgeId];
  const text = SUMMARY_TEXT[status.summary] ?? badge.text;

  const prefix = STATUS_BAR_PREFIX ? `${STATUS_BAR_PREFIX} ` : '';
  return `${prefix}${badge.icon} ${text}`;
}

export function resetMergeReadyStatusBarCache(): void {
  statusBarCache = null;
}

async function loadMergeReadyStatusBarText(options: {
  exec: MergeReadyExec;
  cwd: string;
  timeout: number;
}): Promise<string> {
  try {
    const status = await getMergeReadyStatus({
      exec: options.exec,
      cwd: options.cwd,
      timeout: options.timeout,
    });

    return renderMergeReadyStatusBar(status);
  } catch {
    return UNKNOWN_STATUS_BAR_TEXT;
  }
}

function createStatusBarExec(
  pi: Pick<MergeReadyCommandAPI, 'exec'>,
  ctx: MergeReadyStatusBarContext,
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

function resolveNowMs(value: number | Date | undefined): number {
  if (typeof value === 'number') {
    return value;
  }

  return value?.getTime() ?? Date.now();
}
