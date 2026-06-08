import { type MergeReadyCommandAPI } from './commands.js';
import {
  type MergeReadyExec,
  type MergeReadyExecOptions,
  type MergeReadyExecResult,
} from './git.js';
import { getMergeReadyStatus } from './merge-ready.js';
import { selectMergeReadyBadgeId } from './status.js';
import type { MergeReadyBadgeId, MergeReadyOpenItemId, MergeReadyStatus } from './types.js';

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

export type MergeReadyStatusBarSyncContext = {
  cwd: string;
  ui?: {
    setStatus?: (key: string, status?: string) => void;
    theme?: {
      fg: (color: string, text: string) => string;
    };
  };
};

export type MergeReadyStatusBarSyncOptions = {
  ctx: MergeReadyStatusBarSyncContext;
  status: MergeReadyStatus;
  now?: number | Date;
};

type MergeReadyStatusBarCacheEntry = {
  cwd: string;
  text: string;
  refreshedAtMs: number;
};

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
const STATUS_BAR_TEXT_OVERRIDE_BY_OPEN_ITEM_ID: Partial<Record<MergeReadyOpenItemId, string>> = {
  no_pull_request: 'No PR',
};

let statusBarCache: MergeReadyStatusBarCacheEntry | null = null;
let statusBarSuspensionCount = 0;

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
    renderMergeReadyStatusBarKey(options.ctx, cachedEntry.text);
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

  applyMergeReadyStatusBarText({
    ctx: options.ctx,
    text,
    now: nowMs,
  });

  return {
    text,
    cached: false,
  };
}

export function syncMergeReadyStatusBar(
  options: MergeReadyStatusBarSyncOptions,
): MergeReadyStatusBarRefreshResult {
  const text = renderMergeReadyStatusBar(options.status);

  if (options.status.target.mode === 'url') {
    return {
      text,
      cached: false,
    };
  }

  applyMergeReadyStatusBarText({
    ctx: options.ctx,
    text,
    now: options.now,
  });

  return {
    text,
    cached: false,
  };
}

export function renderMergeReadyStatusBar(status: MergeReadyStatus): string {
  const specialCase = renderStatusBarSpecialCase(status);
  if (specialCase) {
    return specialCase;
  }

  const badgeId = selectMergeReadyBadgeId(status);
  const badge = BADGE_PRESENTATION[badgeId];
  return `${badge.icon} ${renderStatusBarText(status, badgeId)}`;
}

function renderStatusBarSpecialCase(status: MergeReadyStatus): string | null {
  const badgeId = selectMergeReadyBadgeId(status);

  if (badgeId === 'unresolved_conversations') {
    return `❌ 💬 ${formatRequiredUnresolvedConversationText(status)}`;
  }

  if (
    badgeId === 'ready' &&
    status.signals.unresolvedConversations &&
    status.signals.unresolvedConversationRequirement === 'optional'
  ) {
    return `✅ Mergeable · 💬 ${formatOptionalUnresolvedConversationText(status)}`;
  }

  return null;
}

function renderStatusBarText(status: MergeReadyStatus, badgeId: MergeReadyBadgeId): string {
  const topOpenItemId = status.openItems[0]?.id;
  if (topOpenItemId) {
    return (
      STATUS_BAR_TEXT_OVERRIDE_BY_OPEN_ITEM_ID[topOpenItemId] ?? BADGE_PRESENTATION[badgeId].text
    );
  }

  return BADGE_PRESENTATION[badgeId].text;
}

function formatRequiredUnresolvedConversationText(status: MergeReadyStatus): string {
  const count = status.signals.unresolvedConversationCount;

  if (count !== undefined && count > 0) {
    return `${String(count)} unresolved`;
  }

  return 'Unresolved';
}

function formatOptionalUnresolvedConversationText(status: MergeReadyStatus): string {
  const count = status.signals.unresolvedConversationCount;

  if (count !== undefined && count > 0) {
    return `${String(count)} ${count === 1 ? 'comment' : 'comments'}`;
  }

  return 'Comments';
}

export function suspendMergeReadyStatusBar(ctx: MergeReadyStatusBarSyncContext): () => void {
  statusBarSuspensionCount += 1;
  renderMergeReadyStatusBarKey(ctx);

  let resumed = false;
  return () => {
    if (resumed) {
      return;
    }

    resumed = true;
    statusBarSuspensionCount = Math.max(0, statusBarSuspensionCount - 1);

    if (statusBarSuspensionCount > 0) {
      return;
    }

    const cachedEntry = statusBarCache;
    if (cachedEntry?.cwd === ctx.cwd) {
      renderMergeReadyStatusBarKey(ctx, cachedEntry.text);
    }
  };
}

export function isMergeReadyStatusBarSuspended(): boolean {
  return statusBarSuspensionCount > 0;
}

export function resetMergeReadyStatusBarCache(): void {
  statusBarCache = null;
  statusBarSuspensionCount = 0;
}

function applyMergeReadyStatusBarText(options: {
  ctx: MergeReadyStatusBarSyncContext;
  text: string;
  now?: number | Date | undefined;
}): void {
  statusBarCache = {
    cwd: options.ctx.cwd,
    text: options.text,
    refreshedAtMs: resolveNowMs(options.now),
  };

  renderMergeReadyStatusBarKey(options.ctx, options.text);
}

function renderMergeReadyStatusBarKey(ctx: MergeReadyStatusBarSyncContext, text?: string): void {
  if (isMergeReadyStatusBarSuspended()) {
    ctx.ui?.setStatus?.(MERGE_READY_STATUS_BAR_KEY, undefined);
    return;
  }

  ctx.ui?.setStatus?.(
    MERGE_READY_STATUS_BAR_KEY,
    text === undefined ? undefined : (ctx.ui?.theme?.fg('dim', text) ?? text),
  );
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
