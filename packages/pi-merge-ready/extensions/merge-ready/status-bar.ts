import { type MergeReadyCommandAPI } from './commands.js';
import {
  type MergeReadyExec,
  type MergeReadyExecOptions,
  type MergeReadyExecResult,
} from './git.js';
import { BADGE_ICON_BY_ID } from './badge-icon.js';
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
  branchIdentity: string | null;
  refreshedAtMs: number;
};

const BADGE_TEXT_BY_ID = {
  draft: 'Draft',
  merge_conflicts: 'Conflicts',
  branch_out_of_date: 'Out of date',
  merge_blocked: 'Merge blocked',
  ci_failing: 'Checks failing',
  changes_requested: 'Changes requested',
  unresolved_conversations: 'Conversations open',
  ci_running: 'Checks running',
  review_pending: 'Review pending',
  ready: 'Ready',
  merged: 'Merged',
  closed: 'Closed',
  unknown: 'Unknown',
} as const satisfies Record<MergeReadyBadgeId, string>;
const UNKNOWN_STATUS_BAR_TEXT = `${BADGE_ICON_BY_ID.unknown} ${BADGE_TEXT_BY_ID.unknown}`;
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
  const timeout = options.timeout ?? MERGE_READY_STATUS_BAR_TIMEOUT_MS;
  const cachedEntry = await getReusableMergeReadyStatusBarCacheEntry({
    exec: options.exec,
    cwd: options.ctx.cwd,
    force: options.force,
    nowMs,
    timeout,
  });

  if (cachedEntry) {
    renderMergeReadyStatusBarKey(options.ctx, cachedEntry.text);
    return {
      text: cachedEntry.text,
      cached: true,
    };
  }

  const entry = await loadMergeReadyStatusBarEntry({
    exec: options.exec,
    cwd: options.ctx.cwd,
    timeout,
  });

  applyMergeReadyStatusBarText({
    ctx: options.ctx,
    text: entry.text,
    branchIdentity: entry.branchIdentity,
    now: nowMs,
  });

  return {
    text: entry.text,
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
    branchIdentity: resolveAmbientBranchIdentity(options.status),
    now: options.now,
  });

  return {
    text,
    cached: false,
  };
}

export function renderMergeReadyStatusBar(status: MergeReadyStatus): string {
  const badgeId = selectMergeReadyBadgeId(status);
  const specialCase = renderStatusBarSpecialCase(status, badgeId);
  const icon = specialCase?.icon ?? BADGE_ICON_BY_ID[badgeId];
  const caption = specialCase?.caption ?? renderStatusBarText(status, badgeId);
  const prPrefix = status.pr ? `#${String(status.pr.number)} ` : '';

  return `${icon} ${prPrefix}${caption}`;
}

function renderStatusBarSpecialCase(
  status: MergeReadyStatus,
  badgeId: MergeReadyBadgeId,
): { icon: string; caption: string } | null {
  if (badgeId === 'unresolved_conversations') {
    return {
      icon: '❌',
      caption: `💬 ${formatRequiredUnresolvedConversationText(status)}`,
    };
  }

  if (
    badgeId === 'ready' &&
    status.signals.unresolvedConversations &&
    status.signals.unresolvedConversationRequirement === 'optional'
  ) {
    return {
      icon: BADGE_ICON_BY_ID.ready,
      caption: `Mergeable · 💬 ${formatOptionalUnresolvedConversationText(status)}`,
    };
  }

  return null;
}

function renderStatusBarText(status: MergeReadyStatus, badgeId: MergeReadyBadgeId): string {
  const topOpenItemId = status.openItems[0]?.id;
  if (topOpenItemId) {
    return STATUS_BAR_TEXT_OVERRIDE_BY_OPEN_ITEM_ID[topOpenItemId] ?? BADGE_TEXT_BY_ID[badgeId];
  }

  return BADGE_TEXT_BY_ID[badgeId];
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
  branchIdentity: string | null;
  now?: number | Date | undefined;
}): void {
  statusBarCache = {
    cwd: options.ctx.cwd,
    text: options.text,
    branchIdentity: options.branchIdentity,
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

async function loadMergeReadyStatusBarEntry(options: {
  exec: MergeReadyExec;
  cwd: string;
  timeout: number;
}): Promise<{ text: string; branchIdentity: string | null }> {
  try {
    const status = await getMergeReadyStatus({
      exec: options.exec,
      cwd: options.cwd,
      timeout: options.timeout,
    });

    return {
      text: renderMergeReadyStatusBar(status),
      branchIdentity: resolveAmbientBranchIdentity(status),
    };
  } catch {
    return {
      text: UNKNOWN_STATUS_BAR_TEXT,
      branchIdentity: null,
    };
  }
}

async function getReusableMergeReadyStatusBarCacheEntry(options: {
  exec: MergeReadyExec;
  cwd: string;
  force: boolean | undefined;
  nowMs: number;
  timeout: number;
}): Promise<MergeReadyStatusBarCacheEntry | null> {
  const cachedEntry = statusBarCache;

  if (
    options.force ||
    !cachedEntry ||
    cachedEntry.cwd !== options.cwd ||
    cachedEntry.branchIdentity === null ||
    options.nowMs - cachedEntry.refreshedAtMs >= MERGE_READY_STATUS_BAR_TTL_MS
  ) {
    return null;
  }

  const currentBranchIdentity = await probeCurrentBranchIdentity({
    exec: options.exec,
    cwd: options.cwd,
    timeout: options.timeout,
  });

  return currentBranchIdentity === cachedEntry.branchIdentity ? cachedEntry : null;
}

function resolveAmbientBranchIdentity(status: MergeReadyStatus): string | null {
  if (status.target.mode === 'url') {
    return null;
  }

  const targetBranch = status.target.branch?.trim();
  if (targetBranch) {
    return targetBranch;
  }

  const prHeadBranch = status.pr?.headRefName.trim();
  return prHeadBranch ? prHeadBranch : null;
}

async function probeCurrentBranchIdentity(options: {
  exec: MergeReadyExec;
  cwd: string;
  timeout: number;
}): Promise<string | null> {
  try {
    const result = await options.exec('git', ['branch', '--show-current'], {
      cwd: options.cwd,
      timeout: options.timeout,
    });
    const branch = result.stdout?.trim();

    return branch ? branch : null;
  } catch {
    return null;
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
