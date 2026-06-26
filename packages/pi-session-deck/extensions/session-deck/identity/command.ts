import type { Theme } from '@earendil-works/pi-coding-agent';
import { readSessionDeckSnapshot, type ReadSessionDeckSnapshotOptions } from '../reader.js';
import { SessionDeckBrowser } from '../browser.js';
import {
  formatReapedRecord,
  formatSessionDeckDiagnosticLine,
  formatSessionDeckRecord,
  getSessionDeckEmptyMessage,
  getSessionDeckListHeading,
} from '../browser-render.js';
import type { SessionDeckSnapshot } from '../types.js';
import { SESSION_DECK_COMMAND_NAME } from '../presence/constants.js';
import { reapPresenceRecords, type ReapPresenceRecordsOptions } from '../presence/reap.js';
import type { PresenceDiagnostic, PresenceState } from '../presence/types.js';

interface SessionDeckCustomTui {
  requestRender: () => void;
}

interface SessionDeckCustomComponent {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput?: (data: string) => void;
  dispose?: () => void;
}

export interface PresenceCommandContext {
  mode?: string;
  ui: {
    notify: (message: string, level: 'info' | 'warning' | 'error') => void;
    custom?: <T>(
      factory: (
        tui: SessionDeckCustomTui,
        theme: Theme,
        keybindings: unknown,
        done: (result: T) => void,
      ) => SessionDeckCustomComponent,
    ) => Promise<T>;
  };
}

export interface PresenceCommandRegistration {
  description?: string;
  getArgumentCompletions?: (
    prefix: string,
  ) =>
    | Array<{ value: string; label: string }>
    | null
    | Promise<Array<{ value: string; label: string }> | null>;
  handler: (args: string, ctx: PresenceCommandContext) => Promise<void>;
}

export interface PresenceCommandAPI {
  registerCommand: (name: string, options: PresenceCommandRegistration) => void;
}

export interface RegisterSessionDeckCommandOptions extends ReadSessionDeckSnapshotOptions {
  readSessionDeckSnapshot?: typeof readSessionDeckSnapshot;
  reapPresenceRecords?: typeof reapPresenceRecords;
  unlink?: ReapPresenceRecordsOptions['unlink'];
}

export type ParsedSessionDeckCommandArgs =
  | {
      ok: true;
      all: boolean;
      reap: boolean;
      identity: boolean;
    }
  | {
      ok: false;
      message: string;
    };

interface LoadedSessionDeckView {
  all: boolean;
  showIdentity: boolean;
  reapResult: { removed: string[]; diagnostics: PresenceDiagnostic[] } | null;
  view: SessionDeckSnapshot;
}

const SHOW_ALL_FLAG = '--all';
const REAP_FLAG = '--reap';
const IDENTITY_FLAG = '--identity';
const USAGE = `Usage: /${SESSION_DECK_COMMAND_NAME} [${SHOW_ALL_FLAG}] [${REAP_FLAG}] [${IDENTITY_FLAG}]`;
const DEFAULT_VISIBLE_STATES: PresenceState[] = ['live', 'stale'];
const COMMAND_FLAGS = [SHOW_ALL_FLAG, REAP_FLAG, IDENTITY_FLAG] as const;

export function registerSessionDeckCommand(
  pi: PresenceCommandAPI,
  options: RegisterSessionDeckCommandOptions = {},
): void {
  const readSnapshot = options.readSessionDeckSnapshot ?? readSessionDeckSnapshot;
  const reapPresence = options.reapPresenceRecords ?? reapPresenceRecords;

  pi.registerCommand(SESSION_DECK_COMMAND_NAME, {
    description: 'Show Pi session presence, identity, activity, and chips from ~/.pi/session-deck',
    getArgumentCompletions: getSessionDeckCommandCompletions,
    handler: async (args: string, ctx: PresenceCommandContext) => {
      const parsedArgs = parseSessionDeckCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.message, 'error');
        return;
      }

      const loadedView = await loadSessionDeckView(parsedArgs, {
        options,
        readSnapshot,
        reapPresence,
      });

      if (ctx.mode === 'tui' && ctx.ui.custom !== undefined) {
        await openSessionDeckBrowser(ctx, loadedView, async () =>
          readVisibleSessionDeckView(parsedArgs.all, readSnapshot, options),
        );
        return;
      }

      ctx.ui.notify(renderSessionDeckText(loadedView), 'info');
    },
  });
}

export function parseSessionDeckCommandArgs(args: string): ParsedSessionDeckCommandArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  let all = false;
  let reap = false;
  let identity = false;

  for (const token of tokens) {
    if (token === SHOW_ALL_FLAG) {
      if (all) {
        return { ok: false, message: USAGE };
      }
      all = true;
      continue;
    }

    if (token === REAP_FLAG) {
      if (reap) {
        return { ok: false, message: USAGE };
      }
      reap = true;
      continue;
    }

    if (token === IDENTITY_FLAG) {
      if (identity) {
        return { ok: false, message: USAGE };
      }
      identity = true;
      continue;
    }

    return { ok: false, message: USAGE };
  }

  return { ok: true, all, reap, identity };
}

export function renderSessionDeckView(
  view: SessionDeckSnapshot,
  options: { all: boolean; showIdentity: boolean },
): string {
  const lines: string[] = [];

  if (view.records.length === 0) {
    lines.push(getSessionDeckEmptyMessage(options.all));
  } else {
    lines.push(getSessionDeckListHeading(options.all));
    for (const [index, record] of view.records.entries()) {
      if (index > 0) {
        lines.push('');
      }
      lines.push(formatSessionDeckRecord(record, options));
    }
  }

  if (options.all && view.diagnostics.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Diagnostics:');
    for (const diagnostic of view.diagnostics) {
      lines.push(formatSessionDeckDiagnosticLine(diagnostic));
    }
  }

  return lines.join('\n');
}

function renderSessionDeckText(loadedView: LoadedSessionDeckView): string {
  return loadedView.reapResult === null
    ? renderSessionDeckView(loadedView.view, {
        all: loadedView.all,
        showIdentity: loadedView.showIdentity,
      })
    : renderSessionDeckCommandResult(loadedView.view, {
        all: loadedView.all,
        showIdentity: loadedView.showIdentity,
        reapResult: loadedView.reapResult,
      });
}

function renderSessionDeckCommandResult(
  view: SessionDeckSnapshot,
  options: {
    all: boolean;
    showIdentity: boolean;
    reapResult: { removed: string[]; diagnostics: PresenceDiagnostic[] };
  },
): string {
  return [
    ...renderJoinedReapResult(options.reapResult),
    '',
    renderSessionDeckView(view, { all: options.all, showIdentity: options.showIdentity }),
  ].join('\n');
}

function renderJoinedReapResult(result: {
  removed: string[];
  diagnostics: PresenceDiagnostic[];
}): string[] {
  const lines = [formatReapSummary(result.removed.length)];

  if (result.removed.length > 0) {
    lines.push('Removed:');
    for (const filePath of result.removed) {
      lines.push(`- ${formatReapedRecord(filePath)}`);
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push('Reap diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(formatPresenceDiagnostic(diagnostic));
    }
  }

  return lines;
}

async function loadSessionDeckView(
  parsedArgs: Extract<ParsedSessionDeckCommandArgs, { ok: true }>,
  dependencies: {
    options: RegisterSessionDeckCommandOptions;
    readSnapshot: typeof readSessionDeckSnapshot;
    reapPresence: typeof reapPresenceRecords;
  },
): Promise<LoadedSessionDeckView> {
  const reapResult = parsedArgs.reap
    ? await dependencies.reapPresence(getReapOptions(dependencies.options))
    : null;

  return {
    all: parsedArgs.all,
    showIdentity: parsedArgs.identity,
    reapResult,
    view: await readVisibleSessionDeckView(
      parsedArgs.all,
      dependencies.readSnapshot,
      dependencies.options,
    ),
  };
}

async function readVisibleSessionDeckView(
  all: boolean,
  readSnapshot: typeof readSessionDeckSnapshot,
  options: RegisterSessionDeckCommandOptions,
): Promise<SessionDeckSnapshot> {
  return filterVisibleSessionDeckView(
    await readSnapshot(getReadSessionDeckSnapshotOptions(options)),
    all,
  );
}

function filterVisibleSessionDeckView(
  sessionDeckSnapshot: SessionDeckSnapshot,
  all: boolean,
): SessionDeckSnapshot {
  if (all) {
    return sessionDeckSnapshot;
  }

  return {
    generatedAt: sessionDeckSnapshot.generatedAt,
    records: sessionDeckSnapshot.records.filter((record) =>
      DEFAULT_VISIBLE_STATES.includes(record.presenceState),
    ),
    diagnostics: [],
  };
}

async function openSessionDeckBrowser(
  ctx: PresenceCommandContext,
  loadedView: LoadedSessionDeckView,
  reload: () => Promise<SessionDeckSnapshot>,
): Promise<void> {
  if (ctx.ui.custom === undefined) {
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new SessionDeckBrowser({
        all: loadedView.all,
        showIdentity: loadedView.showIdentity,
        initialView: loadedView.view,
        onClose: () => done(undefined),
        reload,
        requestRender: () => tui.requestRender(),
        ...(loadedView.reapResult === null
          ? {}
          : { reapLines: renderJoinedReapResult(loadedView.reapResult) }),
        theme,
      }),
  );
}

function formatReapSummary(removedCount: number): string {
  return `Reap complete: removed ${removedCount} expired presence ${pluralize(
    removedCount,
    'record',
  )}.`;
}

function formatPresenceDiagnostic(diagnostic: PresenceDiagnostic): string {
  const location = diagnostic.filePath === undefined ? '' : ` (${diagnostic.filePath})`;
  return `- ${diagnostic.code}${location}: ${diagnostic.message}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function getSessionDeckCommandCompletions(prefix: string) {
  const matches = COMMAND_FLAGS.filter((flag) => flag.startsWith(prefix)).map((flag) => ({
    value: flag,
    label: flag,
  }));

  return matches.length > 0 ? matches : null;
}

function getReadSessionDeckSnapshotOptions(
  options: RegisterSessionDeckCommandOptions,
): ReadSessionDeckSnapshotOptions {
  return {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.identityDirectory === undefined
      ? {}
      : { identityDirectory: options.identityDirectory }),
    ...(options.activityDirectory === undefined
      ? {}
      : { activityDirectory: options.activityDirectory }),
    ...(options.chipsDirectory === undefined ? {} : { chipsDirectory: options.chipsDirectory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.identityFreshnessThresholds === undefined
      ? {}
      : { identityFreshnessThresholds: options.identityFreshnessThresholds }),
    ...(options.activityThresholds === undefined
      ? {}
      : { activityThresholds: options.activityThresholds }),
    ...(options.inspectPid === undefined ? {} : { inspectPid: options.inspectPid }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };
}

function getReapOptions(options: RegisterSessionDeckCommandOptions): ReapPresenceRecordsOptions {
  return {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.unlink === undefined ? {} : { unlink: options.unlink }),
  };
}

export { SESSION_DECK_COMMAND_NAME };
