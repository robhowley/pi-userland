import { isAbsolute, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  CHIP_DIAGNOSTIC_CODES,
  CHIPS_SCHEMA_VERSION,
  DEFAULT_CHIP_ID,
  DEFAULT_CHIP_LEVEL,
  DEFAULT_CHIP_SCOPE,
  validateSourceSlug,
} from './constants.js';
import type {
  ChipDiagnosticSink,
  ClearSessionDeckChipKey,
  MirroredStatusContext,
  MirroredStatusDiff,
  MirroredStatusSnapshot,
  MirroredStatusTrackingEntry,
  SessionDeckChipRecord,
} from './types.js';
import {
  clearChipRecord,
  type ClearChipRecordOptions,
  writeChipRecord,
  type WriteChipRecordOptions,
} from './writer.js';

const WHITESPACE_PATTERN = /\s+/g;

export interface StatusMirrorOptions {
  now?: () => Date;
  writeRecord?: (
    record: SessionDeckChipRecord,
    options?: WriteChipRecordOptions,
  ) => Promise<string | null>;
  clearRecord?: (
    key: ClearSessionDeckChipKey,
    options?: ClearChipRecordOptions,
  ) => Promise<boolean>;
  onDiagnostic?: ChipDiagnosticSink;
}

export interface SessionDeckStatusMirror {
  reconfigure(
    context: MirroredStatusContext,
    options?: { clearTracked?: boolean; resetSnapshot?: boolean },
  ): Promise<void>;
  resetSnapshot(): Promise<void>;
  observeStatuses(statuses: ReadonlyMap<string, string>): Promise<void>;
  clearTracked(): Promise<void>;
  getSnapshot(): MirroredStatusSnapshot;
}

export interface StatusMirrorFooterContext {
  cwd?: string;
  model?: {
    id?: string;
    provider?: string;
    reasoning?: unknown;
  } | null;
  getContextUsage?: () => {
    percent?: number | null;
    contextWindow?: number | null;
  } | null;
  sessionManager?: {
    getEntries?: () => unknown[];
    getSessionName?: () => string | null;
    getCwd?: () => string;
  };
}

interface FooterThemeLike {
  fg: (tone: string, text: string) => string;
}

interface FooterTuiLike {
  requestRender: () => void;
}

interface FooterDataLike {
  getGitBranch: () => string | null;
  getExtensionStatuses: () => ReadonlyMap<string, string>;
  getAvailableProviderCount: () => number;
  onBranchChange: (callback: () => void) => () => void;
}

interface FooterComponentLike {
  render: (width: number) => string[];
  invalidate: () => void;
  dispose?: () => void;
}

export type StatusMirrorFooterFactory = (
  tui: FooterTuiLike,
  theme: FooterThemeLike,
  footerData: FooterDataLike,
) => FooterComponentLike;

export function sanitizeMirroredStatusText(text: string): string {
  return replaceControlCharacters(stripVTControlCharacters(text))
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

export function diffMirroredStatusSnapshots(
  previous: MirroredStatusSnapshot,
  current: MirroredStatusSnapshot,
): MirroredStatusDiff {
  const upserts: MirroredStatusDiff['upserts'] = [];
  const removals: string[] = [];

  for (const [source, text] of current.entries()) {
    if (previous.get(source) !== text) {
      upserts.push({ source, text });
    }
  }

  for (const source of previous.keys()) {
    if (!current.has(source)) {
      removals.push(source);
    }
  }

  return { upserts, removals };
}

export function createStatusMirror(options: StatusMirrorOptions = {}): SessionDeckStatusMirror {
  const emit = options.onDiagnostic ?? noopDiagnostic;
  const now = options.now ?? (() => new Date());
  const writeRecord = options.writeRecord ?? writeChipRecord;
  const clearRecord = options.clearRecord ?? clearChipRecord;

  let context: MirroredStatusContext | null = null;
  let snapshot = new Map<string, string>();
  const tracked = new Map<string, MirroredStatusTrackingEntry>();
  let pending = Promise.resolve();

  return {
    reconfigure(nextContext, reconfigureOptions = {}) {
      return runSerialized(async () => {
        if (reconfigureOptions.clearTracked === true) {
          await clearTrackedEntries();
        }

        context = nextContext;

        if (reconfigureOptions.resetSnapshot === true) {
          snapshot = new Map();
        }
      });
    },
    resetSnapshot() {
      return runSerialized(async () => {
        snapshot = new Map();
      });
    },
    observeStatuses(statuses) {
      return runSerialized(async () => {
        const current = buildMirroredStatusSnapshot(statuses, emit);
        const diff = diffMirroredStatusSnapshots(snapshot, current);

        for (const source of diff.removals) {
          await clearTrackedSource(source, context);
        }

        if (diff.upserts.length === 0) {
          snapshot = current;
          return;
        }

        if (context === null || context.runtimeId.trim().length === 0) {
          emit(
            CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING,
            'status mirror requires a resolved runtimeId',
          );
          snapshot = removeSourcesFromSnapshot(snapshot, diff.removals);
          return;
        }

        const sessionId = resolveSessionId(context.getSessionId, emit);
        if (sessionId === null) {
          emit(
            CHIP_DIAGNOSTIC_CODES.CHIP_SESSION_ID_MISSING,
            'status mirror requires a resolved sessionId',
          );
          snapshot = removeSourcesFromSnapshot(snapshot, diff.removals);
          return;
        }

        const observedAt = now().toISOString();
        for (const upsert of diff.upserts) {
          await writeMirroredChip({
            runtimeId: context.runtimeId,
            sessionId,
            source: upsert.source,
            text: upsert.text,
            updatedAt: observedAt,
            directory: context.directory,
          });
        }

        snapshot = current;
      });
    },
    clearTracked() {
      return runSerialized(clearTrackedEntries);
    },
    getSnapshot() {
      return new Map(snapshot);
    },
  };

  function runSerialized(operation: () => Promise<void>): Promise<void> {
    const run = pending.then(operation, operation);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function clearTrackedEntries(): Promise<void> {
    const entries = Array.from(tracked.values());
    for (const entry of entries) {
      await clearTrackedEntry(entry);
    }
    tracked.clear();
    snapshot = new Map();
  }

  async function clearTrackedSource(
    source: string,
    activeContext: MirroredStatusContext | null,
  ): Promise<void> {
    const entry =
      findTrackedEntry(tracked, source, activeContext?.runtimeId) ??
      buildFallbackTrackedEntry(source, activeContext);
    if (entry === null) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING,
        `status mirror cannot clear "${source}" without a runtimeId`,
      );
      return;
    }

    await clearTrackedEntry(entry);
  }

  async function clearTrackedEntry(entry: MirroredStatusTrackingEntry): Promise<void> {
    try {
      await clearRecord(
        {
          source: entry.source,
          chipId: DEFAULT_CHIP_ID,
          scope: DEFAULT_CHIP_SCOPE,
          runtimeId: entry.runtimeId,
        },
        {
          ...(entry.directory === undefined ? {} : { directory: entry.directory }),
          onDiagnostic: emit,
        },
      );
    } catch (error) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
        `Failed to clear mirrored chip "${entry.source}": ${getErrorMessage(error)}`,
      );
    }

    tracked.delete(getTrackedEntryKey(entry.runtimeId, entry.source));
  }

  async function writeMirroredChip(input: {
    runtimeId: string;
    sessionId: string;
    source: string;
    text: string;
    updatedAt: string;
    directory: string | undefined;
  }): Promise<void> {
    const record: SessionDeckChipRecord = {
      schemaVersion: CHIPS_SCHEMA_VERSION,
      runtimeId: input.runtimeId,
      sessionId: input.sessionId,
      source: input.source,
      chipId: DEFAULT_CHIP_ID,
      scope: DEFAULT_CHIP_SCOPE,
      text: input.text,
      level: DEFAULT_CHIP_LEVEL,
      updatedAt: input.updatedAt,
    };

    try {
      await writeRecord(record, {
        ...(input.directory === undefined ? {} : { directory: input.directory }),
        onDiagnostic: emit,
      });
    } catch (error) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
        `Failed to write mirrored chip "${input.source}": ${getErrorMessage(error)}`,
      );
    }

    tracked.set(getTrackedEntryKey(input.runtimeId, input.source), {
      runtimeId: input.runtimeId,
      source: input.source,
      chipId: DEFAULT_CHIP_ID,
      scope: DEFAULT_CHIP_SCOPE,
      ...(input.directory === undefined ? {} : { directory: input.directory }),
    });
  }
}

export function createStatusMirrorFooterFactory(
  context: StatusMirrorFooterContext,
  mirror: SessionDeckStatusMirror,
  options: { onDiagnostic?: ChipDiagnosticSink } = {},
): StatusMirrorFooterFactory {
  const emit = options.onDiagnostic ?? noopDiagnostic;

  return (tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => {
      try {
        tui.requestRender();
      } catch (error) {
        emit(
          CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
          `Failed to request footer render: ${getErrorMessage(error)}`,
        );
      }
    });

    return {
      dispose: unsubscribe,
      invalidate() {
        // no-op; footerData owns branch invalidation and status mirroring samples on render
      },
      render(width) {
        try {
          const statuses = footerData.getExtensionStatuses();
          void mirror.observeStatuses(statuses);
          return renderFooterLines(width, theme, footerData, context, statuses);
        } catch (error) {
          emit(
            CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
            `Failed to render session-deck footer mirror: ${getErrorMessage(error)}`,
          );
          return [];
        }
      },
    };
  };
}

function buildMirroredStatusSnapshot(
  statuses: ReadonlyMap<string, string>,
  emit: ChipDiagnosticSink,
): Map<string, string> {
  const snapshot = new Map<string, string>();

  for (const [source, text] of statuses.entries()) {
    const sourceValidation = validateSourceSlug(source);
    if (!sourceValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
      continue;
    }

    const sanitized = sanitizeMirroredStatusText(text);
    if (sanitized.length === 0) {
      emit(
        CHIP_DIAGNOSTIC_CODES.CHIP_TEXT_EMPTY,
        `status mirror text for "${source}" is empty after sanitize`,
      );
      continue;
    }

    snapshot.set(sourceValidation.value, sanitized);
  }

  return snapshot;
}

function renderFooterLines(
  width: number,
  theme: FooterThemeLike,
  footerData: FooterDataLike,
  context: StatusMirrorFooterContext,
  statuses: ReadonlyMap<string, string>,
): string[] {
  const lines = [
    applyTheme(theme, 'dim', truncateToWidth(renderPwdLine(footerData, context), width)),
    applyTheme(theme, 'dim', renderStatsLine(width, footerData, context)),
  ];

  const statusTexts = Array.from(statuses.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeMirroredStatusText(text))
    .filter((text) => text.length > 0);

  if (statusTexts.length > 0) {
    lines.push(applyTheme(theme, 'dim', truncateToWidth(statusTexts.join(' '), width)));
  }

  return lines;
}

function renderPwdLine(footerData: FooterDataLike, context: StatusMirrorFooterContext): string {
  const cwd = resolveFooterCwd(context);
  let pwd = formatCwdForFooter(cwd, process.env['HOME'] || process.env['USERPROFILE']);

  const branch = safeCall(() => footerData.getGitBranch(), null);
  if (branch !== null && branch.length > 0) {
    pwd = `${pwd} (${branch})`;
  }

  const sessionName = safeCall(() => context.sessionManager?.getSessionName?.() ?? null, null);
  if (sessionName !== null && sessionName.length > 0) {
    pwd = `${pwd} • ${sessionName}`;
  }

  return pwd;
}

function renderStatsLine(
  width: number,
  footerData: FooterDataLike,
  context: StatusMirrorFooterContext,
): string {
  const totals = getAssistantUsageTotals(context.sessionManager?.getEntries);
  const statsParts: string[] = [];

  if (totals.input > 0) {
    statsParts.push(`↑${formatTokens(totals.input)}`);
  }
  if (totals.output > 0) {
    statsParts.push(`↓${formatTokens(totals.output)}`);
  }
  if (totals.cacheRead > 0) {
    statsParts.push(`R${formatTokens(totals.cacheRead)}`);
  }
  if (totals.cacheWrite > 0) {
    statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
  }
  if (totals.cost > 0) {
    statsParts.push(`$${totals.cost.toFixed(3)}`);
  }

  const contextUsage = safeCall(() => context.getContextUsage?.() ?? null, null);
  const contextWindow =
    typeof contextUsage?.contextWindow === 'number' && contextUsage.contextWindow > 0
      ? contextUsage.contextWindow
      : null;
  const contextPercent =
    typeof contextUsage?.percent === 'number' ? contextUsage.percent.toFixed(1) : null;
  if (contextWindow !== null || contextPercent !== null) {
    const left = contextPercent ?? '?';
    const right = contextWindow === null ? '?' : formatTokens(contextWindow);
    statsParts.push(`${left}%/${right}`.replace('?%/', '?/'));
  }

  const leftText = statsParts.join(' ');
  const baseModel = typeof context.model?.id === 'string' ? context.model.id : 'no-model';
  const providerCount = safeCall(() => footerData.getAvailableProviderCount(), 0);
  const rightText =
    providerCount > 1 && typeof context.model?.provider === 'string'
      ? `(${context.model.provider}) ${baseModel}`
      : baseModel;

  if (leftText.length === 0) {
    return truncateToWidth(rightText, width);
  }

  return alignFooterSides(leftText, rightText, width);
}

function getAssistantUsageTotals(getEntries: (() => unknown[]) | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  const entries = safeCall(() => getEntries?.() ?? [], [] as unknown[]);
  for (const entry of entries) {
    if (!isObject(entry) || entry['type'] !== 'message') {
      continue;
    }

    const message = entry['message'];
    if (!isObject(message) || message['role'] !== 'assistant') {
      continue;
    }

    const usage = message['usage'];
    if (!isObject(usage)) {
      continue;
    }

    totals.input += getNumber(usage['input']);
    totals.output += getNumber(usage['output']);
    totals.cacheRead += getNumber(usage['cacheRead']);
    totals.cacheWrite += getNumber(usage['cacheWrite']);

    const cost = usage['cost'];
    if (isObject(cost)) {
      totals.cost += getNumber(cost['total']);
    }
  }

  return totals;
}

function resolveSessionId(
  getSessionId: () => string | null,
  emit: ChipDiagnosticSink,
): string | null {
  try {
    const sessionId = getSessionId();
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : null;
  } catch (error) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_MIRROR_ERROR,
      `Failed to resolve mirror sessionId: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

function buildFallbackTrackedEntry(
  source: string,
  context: MirroredStatusContext | null,
): MirroredStatusTrackingEntry | null {
  if (context === null || context.runtimeId.trim().length === 0) {
    return null;
  }

  return {
    runtimeId: context.runtimeId,
    source,
    chipId: DEFAULT_CHIP_ID,
    scope: DEFAULT_CHIP_SCOPE,
    ...(context.directory === undefined ? {} : { directory: context.directory }),
  };
}

function findTrackedEntry(
  tracked: ReadonlyMap<string, MirroredStatusTrackingEntry>,
  source: string,
  runtimeId: string | undefined,
): MirroredStatusTrackingEntry | undefined {
  if (runtimeId !== undefined) {
    const direct = trackedLookup(tracked, source, runtimeId);
    if (direct !== undefined) {
      return direct;
    }
  }

  return Array.from(tracked.values()).find((entry) => entry.source === source);
}

function trackedLookup(
  tracked: ReadonlyMap<string, MirroredStatusTrackingEntry>,
  source: string,
  runtimeId: string,
): MirroredStatusTrackingEntry | undefined {
  return tracked.get(getTrackedEntryKey(runtimeId, source));
}

function getTrackedEntryKey(runtimeId: string, source: string): string {
  return `${runtimeId}:${source}`;
}

function removeSourcesFromSnapshot(
  previous: MirroredStatusSnapshot,
  removals: readonly string[],
): Map<string, string> {
  const next = new Map(previous);
  for (const source of removals) {
    next.delete(source);
  }
  return next;
}

function resolveFooterCwd(context: StatusMirrorFooterContext): string {
  return (
    context.cwd ??
    safeCall(() => context.sessionManager?.getCwd?.() ?? process.cwd(), process.cwd())
  );
}

function applyTheme(theme: FooterThemeLike, tone: string, text: string): string {
  return safeCall(() => theme.fg(tone, text), text);
}

function alignFooterSides(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  const minimumPadding = 2;

  if (leftWidth + minimumPadding + rightWidth <= width) {
    return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
  }

  const availableForRight = Math.max(0, width - leftWidth - minimumPadding);
  if (availableForRight === 0) {
    return truncateToWidth(left, width);
  }

  const truncatedRight = truncateToWidth(right, availableForRight, '');
  const padding = ' '.repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)));
  return `${left}${padding}${truncatedRight}`;
}

function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

function truncateToWidth(text: string, width: number, ellipsis = '...'): string {
  if (width <= 0) {
    return '';
  }

  if (visibleWidth(text) <= width) {
    return text;
  }

  if (ellipsis.length >= width) {
    return ellipsis.slice(0, width);
  }

  return `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) {
    return count.toString();
  }
  if (count < 10_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  if (count < 1_000_000) {
    return `${Math.round(count / 1_000)}k`;
  }
  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (home === undefined) {
    return cwd;
  }

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === '' ||
    (relativeToHome !== '..' &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) {
    return cwd;
  }

  return relativeToHome === '' ? '~' : `~${sep}${relativeToHome}`;
}

function replaceControlCharacters(text: string): string {
  let sanitized = '';

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += isControlCodePoint(codePoint) ? ' ' : character;
  }

  return sanitized;
}

function isControlCodePoint(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159);
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function noopDiagnostic(_code: string, _message: string): void {
  // intentionally empty
}
