import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type MergeReadyCommandAPI } from './commands.js';
import { type MergeReadyConfig, loadMergeReadyConfig } from './config.js';
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

export type MergeReadyStatusBarEventName = 'session_start' | 'turn_end' | 'session_shutdown';

export type MergeReadyStatusBarContext = {
  cwd: string;
  hasUI?: boolean;
  isProjectTrusted?: () => boolean;
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
  projectTrusted?: boolean;
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
  projectTrusted?: boolean;
};

type MergeReadyStatusBarCacheEntry = {
  cwd: string;
  text: string;
  branchIdentity: string | null;
  refreshedAtMs: number;
  ttlMs: number;
};

type MergeReadyStatusBarAmbientSnapshot = {
  cwd: string;
  hasUI?: boolean;
  setStatus?: (key: string, status?: string) => void;
  theme?: {
    fg: (color: string, text: string) => string;
  };
};

type MergeReadyStatusBarAmbientOwnership = {
  generation: number;
};

type MergeReadyStatusBarRuntime = {
  exec: MergeReadyExec | null;
  ctx: MergeReadyStatusBarAmbientSnapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
  dueAtMs: number | null;
  generation: number;
  diagnosticsEnabled: boolean;
};

type MergeReadyStatusBarInternalRefreshOptions = MergeReadyStatusBarRefreshOptions & {
  ownership?: MergeReadyStatusBarAmbientOwnership;
  ttlMs?: number;
  diagnosticsEnabled?: boolean;
};

type MergeReadyStatusBarRuntimeSettings = {
  ttlMs: number;
  diagnosticsEnabled: MergeReadyConfig['enableStatusBarDiagnostics'];
};

const MERGE_READY_STATUS_BAR_DEBUG_DIR_ENV = 'PI_MERGE_READY_DEBUG_DIR';
const MERGE_READY_STATUS_BAR_DEBUG_FILE_NAME = 'status-bar-debug.jsonl';

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
let statusBarRuntime: MergeReadyStatusBarRuntime = createMergeReadyStatusBarRuntime();

export function registerMergeReadyStatusBar(pi: MergeReadyStatusBarAPI): void {
  pi.on('session_shutdown', () => {
    invalidateMergeReadyStatusBarRuntime();
  });

  pi.on('session_start', async (_event, ctx) => {
    invalidateMergeReadyStatusBarRuntime();

    await refreshMergeReadyStatusBar({
      exec: createStatusBarExec(pi, ctx),
      ctx,
      force: true,
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
    });
  });

  pi.on('turn_end', async (_event, ctx) => {
    await refreshMergeReadyStatusBar({
      exec: createStatusBarExec(pi, ctx),
      ctx,
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
    });
  });
}

export async function refreshMergeReadyStatusBar(
  options: MergeReadyStatusBarRefreshOptions,
): Promise<MergeReadyStatusBarRefreshResult | null> {
  if (options.ctx.hasUI === false) {
    return null;
  }

  const ownership = rememberMergeReadyStatusBarRefreshOwner(options);
  return refreshMergeReadyStatusBarInternal({
    ...options,
    ownership,
  });
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

  const { diagnosticsEnabled, ttlMs } = resolveMergeReadyStatusBarRuntimeSettings({
    cwd: options.ctx.cwd,
    ...(options.projectTrusted === undefined ? {} : { projectTrusted: options.projectTrusted }),
  });

  rememberMergeReadyStatusBarSyncContext(options.ctx);
  applyMergeReadyStatusBarText({
    ctx: options.ctx,
    text,
    branchIdentity: resolveAmbientBranchIdentity(options.status),
    now: options.now,
    ttlMs,
    diagnosticsEnabled,
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
  clearMergeReadyStatusBarTimer();
  statusBarCache = null;
  statusBarSuspensionCount = 0;
  statusBarRuntime = createMergeReadyStatusBarRuntime();
}

function applyMergeReadyStatusBarText(options: {
  ctx: MergeReadyStatusBarSyncContext;
  text: string;
  branchIdentity: string | null;
  now?: number | Date | undefined;
  ttlMs: number;
  diagnosticsEnabled: boolean;
}): void {
  const refreshedAtMs = resolveNowMs(options.now);

  statusBarCache = {
    cwd: options.ctx.cwd,
    text: options.text,
    branchIdentity: options.branchIdentity,
    refreshedAtMs,
    ttlMs: options.ttlMs,
  };
  statusBarRuntime.diagnosticsEnabled = options.diagnosticsEnabled;

  renderMergeReadyStatusBarKey(options.ctx, options.text);
  rearmMergeReadyStatusBarTimer();
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

async function refreshMergeReadyStatusBarInternal(
  options: MergeReadyStatusBarInternalRefreshOptions,
): Promise<MergeReadyStatusBarRefreshResult | null> {
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
    if (!isMergeReadyStatusBarOwnershipCurrent(options.ownership)) {
      return null;
    }

    renderMergeReadyStatusBarKey(options.ctx, cachedEntry.text);
    return {
      text: cachedEntry.text,
      cached: true,
    };
  }

  const runtimeSettings =
    options.ttlMs === undefined || options.diagnosticsEnabled === undefined
      ? resolveMergeReadyStatusBarRuntimeSettings({
          cwd: options.ctx.cwd,
          ...(options.projectTrusted === undefined ? {} : { projectTrusted: options.projectTrusted }),
        })
      : null;
  const ttlMs = options.ttlMs ?? runtimeSettings!.ttlMs;
  const diagnosticsEnabled = options.diagnosticsEnabled ?? runtimeSettings!.diagnosticsEnabled;
  const entry = await loadMergeReadyStatusBarEntry({
    exec: options.exec,
    cwd: options.ctx.cwd,
    timeout,
    diagnosticsEnabled,
  });

  if (!isMergeReadyStatusBarOwnershipCurrent(options.ownership)) {
    return null;
  }

  applyMergeReadyStatusBarText({
    ctx: options.ctx,
    text: entry.text,
    branchIdentity: entry.branchIdentity,
    now: nowMs,
    ttlMs,
    diagnosticsEnabled,
  });

  return {
    text: entry.text,
    cached: false,
  };
}

async function loadMergeReadyStatusBarEntry(options: {
  exec: MergeReadyExec;
  cwd: string;
  timeout: number;
  diagnosticsEnabled: boolean;
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
  } catch (error) {
    logMergeReadyStatusBarCaughtError({
      stage: 'load_merge_ready_status_bar_entry',
      cwd: options.cwd,
      error,
      diagnosticsEnabled: options.diagnosticsEnabled,
    });
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
    options.nowMs - cachedEntry.refreshedAtMs >= cachedEntry.ttlMs
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

function resolveMergeReadyStatusBarRuntimeSettings(options: {
  cwd: string;
  projectTrusted?: boolean;
}): MergeReadyStatusBarRuntimeSettings {
  const config = loadMergeReadyConfig(options.cwd, options.projectTrusted ?? false);

  return {
    ttlMs: config.cacheTTLSeconds * 1_000,
    diagnosticsEnabled: config.enableStatusBarDiagnostics,
  };
}

function resolveNowMs(value: number | Date | undefined): number {
  if (typeof value === 'number') {
    return value;
  }

  return value?.getTime() ?? Date.now();
}

function appendMergeReadyStatusBarDebugLogIfEnabled(
  diagnosticsEnabled: boolean,
  entry: { event: string } & Record<string, unknown>,
): void {
  if (!diagnosticsEnabled) {
    return;
  }

  appendMergeReadyStatusBarDebugLog(entry);
}

function appendMergeReadyStatusBarDebugLog(
  entry: { event: string } & Record<string, unknown>,
): void {
  const debugDir = resolveMergeReadyStatusBarDebugDir();
  if (debugDir === null) {
    return;
  }

  try {
    mkdirSync(debugDir, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(debugDir, MERGE_READY_STATUS_BAR_DEBUG_FILE_NAME),
      `${JSON.stringify({
        ts: new Date(resolveNowMs(undefined)).toISOString(),
        pid: process.pid,
        ...entry,
      })}\n`,
      'utf8',
    );
  } catch {
    // Ignore best-effort diagnostics failures.
  }
}

function resolveMergeReadyStatusBarDebugDir(): string | null {
  const override = process.env[MERGE_READY_STATUS_BAR_DEBUG_DIR_ENV]?.trim();
  if (override) {
    return override;
  }

  if (process.env['VITEST'] === 'true' || process.env['NODE_ENV'] === 'test') {
    return null;
  }

  return join(homedir(), '.pi', 'merge-ready');
}

function logMergeReadyStatusBarCaughtError(options: {
  stage: string;
  error: unknown;
  cwd?: string;
  generation?: number;
  dueAtMs?: number | null;
  diagnosticsEnabled: boolean;
}): void {
  appendMergeReadyStatusBarDebugLogIfEnabled(options.diagnosticsEnabled, {
    event: 'caught_error',
    stage: options.stage,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.dueAtMs === undefined ? {} : { dueAtMs: options.dueAtMs }),
    ...formatMergeReadyStatusBarDebugError(options.error),
  });
}

function formatMergeReadyStatusBarDebugError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    };
  }

  return {
    errorMessage: typeof error === 'string' ? error : String(error),
  };
}

function createMergeReadyStatusBarRuntime(): MergeReadyStatusBarRuntime {
  return {
    exec: null,
    ctx: null,
    timer: null,
    dueAtMs: null,
    generation: 0,
    diagnosticsEnabled: false,
  };
}

function invalidateMergeReadyStatusBarRuntime(): void {
  clearMergeReadyStatusBarTimer();
  statusBarRuntime.exec = null;
  statusBarRuntime.ctx = null;
  statusBarRuntime.dueAtMs = null;
  statusBarRuntime.diagnosticsEnabled = false;
  statusBarRuntime.generation += 1;
}

function clearMergeReadyStatusBarTimer(): void {
  if (statusBarRuntime.timer !== null) {
    clearTimeout(statusBarRuntime.timer);
    statusBarRuntime.timer = null;
  }
}

function rememberMergeReadyStatusBarRefreshOwner(
  options: Pick<MergeReadyStatusBarRefreshOptions, 'exec' | 'ctx'>,
): MergeReadyStatusBarAmbientOwnership {
  statusBarRuntime.exec = options.exec;
  statusBarRuntime.ctx = createMergeReadyStatusBarAmbientSnapshot(options.ctx);

  return {
    generation: statusBarRuntime.generation,
  };
}

function rememberMergeReadyStatusBarSyncContext(ctx: MergeReadyStatusBarSyncContext): void {
  const nextSnapshot = createMergeReadyStatusBarAmbientSnapshot(ctx);

  statusBarRuntime.ctx = {
    cwd: nextSnapshot.cwd,
    ...(statusBarRuntime.ctx?.hasUI === undefined ? {} : { hasUI: statusBarRuntime.ctx.hasUI }),
    ...(nextSnapshot.setStatus === undefined
      ? statusBarRuntime.ctx?.setStatus === undefined
        ? {}
        : { setStatus: statusBarRuntime.ctx.setStatus }
      : { setStatus: nextSnapshot.setStatus }),
    ...(nextSnapshot.theme === undefined
      ? statusBarRuntime.ctx?.theme === undefined
        ? {}
        : { theme: statusBarRuntime.ctx.theme }
      : { theme: nextSnapshot.theme }),
  };
}

function createMergeReadyStatusBarAmbientSnapshot(
  ctx: MergeReadyStatusBarContext | MergeReadyStatusBarSyncContext,
): MergeReadyStatusBarAmbientSnapshot {
  return {
    cwd: ctx.cwd,
    ...('hasUI' in ctx && ctx.hasUI !== undefined ? { hasUI: ctx.hasUI } : {}),
    ...(ctx.ui?.setStatus === undefined ? {} : { setStatus: ctx.ui.setStatus }),
    ...(ctx.ui?.theme === undefined ? {} : { theme: { fg: ctx.ui.theme.fg.bind(ctx.ui.theme) } }),
  };
}

function isMergeReadyStatusBarOwnershipCurrent(
  ownership: MergeReadyStatusBarAmbientOwnership | undefined,
): boolean {
  return ownership === undefined || ownership.generation === statusBarRuntime.generation;
}

function rearmMergeReadyStatusBarTimer(): void {
  const cachedEntry = statusBarCache;
  if (!cachedEntry || statusBarRuntime.exec === null || statusBarRuntime.ctx === null) {
    return;
  }

  const ttlMs = cachedEntry.ttlMs;
  const diagnosticsEnabled = statusBarRuntime.diagnosticsEnabled;
  const armedAtMs = resolveNowMs(undefined);
  const dueAtMs = cachedEntry.refreshedAtMs + ttlMs;
  const delayMs = Math.max(0, dueAtMs - armedAtMs);
  const generation = statusBarRuntime.generation;

  clearMergeReadyStatusBarTimer();
  statusBarRuntime.dueAtMs = dueAtMs;
  const timer = setTimeout(() => {
    const snapshot = statusBarRuntime.ctx;
    const exec = statusBarRuntime.exec;

    if (
      snapshot === null ||
      exec === null ||
      statusBarRuntime.timer !== timer ||
      statusBarRuntime.generation !== generation ||
      statusBarRuntime.dueAtMs !== dueAtMs
    ) {
      return;
    }

    statusBarRuntime.timer = null;
    appendMergeReadyStatusBarDebugLogIfEnabled(diagnosticsEnabled, {
      event: 'timer_fired',
      cwd: snapshot.cwd,
      generation,
      dueAtMs,
      firedAtMs: resolveNowMs(undefined),
    });
    void refreshMergeReadyStatusBarInternal({
      exec,
      ctx: createMergeReadyStatusBarContext(snapshot),
      force: true,
      ownership: { generation },
      ttlMs,
      diagnosticsEnabled,
    })
      .then((result) => {
        appendMergeReadyStatusBarDebugLogIfEnabled(diagnosticsEnabled, {
          event: 'refresh_result',
          cwd: snapshot.cwd,
          generation,
          dueAtMs,
          text: result?.text ?? null,
          cached: result?.cached ?? null,
        });
      })
      .catch((error) => {
        logMergeReadyStatusBarCaughtError({
          stage: 'timer_refresh',
          cwd: snapshot.cwd,
          generation,
          dueAtMs,
          error,
          diagnosticsEnabled,
        });
      });
  }, delayMs);
  statusBarRuntime.timer = timer;
  timer.unref?.();
  appendMergeReadyStatusBarDebugLogIfEnabled(diagnosticsEnabled, {
    event: 'timer_armed',
    cwd: cachedEntry.cwd,
    generation,
    armedAtMs,
    dueAtMs,
    delayMs,
    ttlMs,
  });
}

function createMergeReadyStatusBarContext(
  snapshot: MergeReadyStatusBarAmbientSnapshot,
): MergeReadyStatusBarContext {
  return {
    cwd: snapshot.cwd,
    ...(snapshot.hasUI === undefined ? {} : { hasUI: snapshot.hasUI }),
    ...(snapshot.setStatus === undefined
      ? {}
      : {
          ui: {
            setStatus: snapshot.setStatus,
            ...(snapshot.theme === undefined ? {} : { theme: snapshot.theme }),
          },
        }),
  };
}
