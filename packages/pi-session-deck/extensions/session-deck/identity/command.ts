import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  getSessionDeckIterm2CommandCompletions,
  isSessionDeckIterm2Command,
  runSessionDeckIterm2Command,
} from '../iterm2/command.js';
import { readSessionDeckSnapshot, type ReadSessionDeckSnapshotOptions } from '../reader.js';
import {
  SessionDeckBrowser,
  type SessionDeckBrowserCreateWorktree,
  type SessionDeckBrowserOpenSelectedResult,
} from '../browser.js';
import { orchestrateCreateWorktree } from '../worktree/orchestrate.js';
import { resolveWorktreeLaunchContextPreview } from '../worktree/preview.js';
import { openTerminalForRuntime, type OpenTerminalForRuntimeOptions } from './open.js';
export {
  openIterm2TerminalForRuntime,
  openTerminalForRuntime,
  type OpenIterm2TerminalForRuntimeOptions,
  type OpenTerminalForRuntimeOptions,
  type SessionDeckOpenSelectedResult,
} from './open.js';
import {
  formatReapedRecord,
  formatSessionDeckDiagnosticLine,
  formatSessionDeckRecord,
  getSessionDeckEmptyMessage,
  getSessionDeckListHeading,
} from '../browser-render.js';
import {
  withTerminalDisplayHints,
  type ReadSessionDeckBrowserSnapshotOptions,
  type SessionDeckBrowserSnapshot,
} from '../browser-view.js';
import { toPublicSessionDeckRecord } from '../public-record.js';
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
  isSessionDeckIterm2Command?: typeof isSessionDeckIterm2Command;
  readSessionDeckSnapshot?: typeof readSessionDeckSnapshot;
  reapPresenceRecords?: typeof reapPresenceRecords;
  runSessionDeckIterm2Command?: typeof runSessionDeckIterm2Command;
  unlink?: ReapPresenceRecordsOptions['unlink'];
  openTerminal?: (runtimeId: string) => Promise<SessionDeckBrowserOpenSelectedResult>;
  openIterm2Terminal?: (runtimeId: string) => Promise<SessionDeckBrowserOpenSelectedResult>;
  createWorktree?: SessionDeckBrowserCreateWorktree;
}

export type ParsedSessionDeckCommandArgs =
  | {
      ok: true;
      all: boolean;
      reap: boolean;
      identity: boolean;
      json: false;
      sessionId: null;
    }
  | {
      ok: true;
      all: boolean;
      reap: boolean;
      identity: boolean;
      json: true;
      sessionId: string;
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
const JSON_FLAG = '--json';
const SESSION_ID_FLAG = '--session-id';
const DEFAULT_VISIBLE_STATES: PresenceState[] = ['live', 'stale'];
const COMMAND_FLAGS = [
  SHOW_ALL_FLAG,
  REAP_FLAG,
  IDENTITY_FLAG,
  JSON_FLAG,
  SESSION_ID_FLAG,
] as const;

export function registerSessionDeckCommand(
  pi: PresenceCommandAPI,
  options: RegisterSessionDeckCommandOptions = {},
): void {
  const isIterm2Command = options.isSessionDeckIterm2Command ?? isSessionDeckIterm2Command;
  const readSnapshot = options.readSessionDeckSnapshot ?? readSessionDeckSnapshot;
  const reapPresence = options.reapPresenceRecords ?? reapPresenceRecords;
  const runIterm2Command = options.runSessionDeckIterm2Command ?? runSessionDeckIterm2Command;

  pi.registerCommand(SESSION_DECK_COMMAND_NAME, {
    description:
      'Show Pi session presence, identity, activity, and chips from ~/.pi/session-deck, or manage the iTerm2 Toolbelt install',
    getArgumentCompletions: getSessionDeckCommandCompletions,
    handler: async (args: string, ctx: PresenceCommandContext) => {
      if (isIterm2Command(args)) {
        const result = await runIterm2Command(args);
        ctx.ui.notify(result.message, result.level);
        return;
      }

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

      if (parsedArgs.json) {
        const jsonResult = renderSessionDeckJsonLookup(loadedView.view, parsedArgs.sessionId);
        ctx.ui.notify(jsonResult.message, jsonResult.level);
        return;
      }

      if (ctx.mode === 'tui' && ctx.ui.custom !== undefined) {
        const openTerminal =
          options.openTerminal ??
          options.openIterm2Terminal ??
          ((runtimeId: string) =>
            openTerminalForRuntime(runtimeId, getOpenTerminalForRuntimeOptions(options)));

        await openSessionDeckBrowser(
          ctx,
          loadedView,
          await withTerminalDisplayHints(loadedView.view, getTerminalDisplayHintOptions(options)),
          async () => readVisibleSessionDeckBrowserView(parsedArgs.all, readSnapshot, options),
          openTerminal,
          options.createWorktree ??
            ((request, onStatus) =>
              orchestrateCreateWorktree(request, {
                onStatus,
                ...(options.identityDirectory === undefined
                  ? {}
                  : { identityDirectory: options.identityDirectory }),
                ...(options.directory === undefined
                  ? {}
                  : { presenceDirectory: options.directory }),
                ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
                ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
                ...(options.now === undefined ? {} : { now: options.now }),
              })),
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
  let json = false;
  let sessionId: string | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token === SHOW_ALL_FLAG) {
      if (all) {
        return { ok: false, message: `Duplicate flag: ${SHOW_ALL_FLAG}` };
      }
      all = true;
      continue;
    }

    if (token === REAP_FLAG) {
      if (reap) {
        return { ok: false, message: `Duplicate flag: ${REAP_FLAG}` };
      }
      reap = true;
      continue;
    }

    if (token === IDENTITY_FLAG) {
      if (identity) {
        return { ok: false, message: `Duplicate flag: ${IDENTITY_FLAG}` };
      }
      identity = true;
      continue;
    }

    if (token === JSON_FLAG) {
      if (json) {
        return { ok: false, message: `Duplicate flag: ${JSON_FLAG}` };
      }
      json = true;
      continue;
    }

    if (token === SESSION_ID_FLAG) {
      if (sessionId !== null) {
        return { ok: false, message: `Duplicate flag: ${SESSION_ID_FLAG}` };
      }

      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `Missing value for ${SESSION_ID_FLAG}` };
      }

      sessionId = value;
      index += 1;
      continue;
    }

    return { ok: false, message: `Unsupported argument: ${token}` };
  }

  if (json && sessionId === null) {
    return { ok: false, message: `${JSON_FLAG} requires ${SESSION_ID_FLAG} <id>` };
  }

  if (!json && sessionId !== null) {
    return { ok: false, message: `${SESSION_ID_FLAG} requires ${JSON_FLAG}` };
  }

  return json
    ? { ok: true, all, reap, identity, json: true, sessionId: sessionId! }
    : { ok: true, all, reap, identity, json: false, sessionId: null };
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

function renderSessionDeckJsonLookup(
  view: SessionDeckSnapshot,
  sessionId: string,
): { level: 'info' | 'error'; message: string } {
  const matches = view.records.filter((record) => record.sessionId === sessionId);

  if (matches.length === 0) {
    return {
      level: 'error',
      message: `No matching session found for session id "${sessionId}".`,
    };
  }

  if (matches.length > 1) {
    return {
      level: 'error',
      message: `Ambiguous session id "${sessionId}": matched ${matches.length} sessions.`,
    };
  }

  return {
    level: 'info',
    message: JSON.stringify(toPublicSessionDeckRecord(matches[0]!), null, 2),
  };
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

async function readVisibleSessionDeckBrowserView(
  all: boolean,
  readSnapshot: typeof readSessionDeckSnapshot,
  options: RegisterSessionDeckCommandOptions,
): Promise<SessionDeckBrowserSnapshot> {
  return withTerminalDisplayHints(
    await readVisibleSessionDeckView(all, readSnapshot, options),
    getTerminalDisplayHintOptions(options),
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
  initialView: SessionDeckBrowserSnapshot,
  reload: () => Promise<SessionDeckBrowserSnapshot>,
  openTerminal: (runtimeId: string) => Promise<SessionDeckBrowserOpenSelectedResult>,
  createWorktree: SessionDeckBrowserCreateWorktree,
): Promise<void> {
  if (ctx.ui.custom === undefined) {
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new SessionDeckBrowser({
        all: loadedView.all,
        showIdentity: loadedView.showIdentity,
        initialView,
        onClose: () => done(undefined),
        openSelected: (record) => openTerminal(record.runtimeId),
        createWorktree,
        previewLaunchContext: (agentDir) => resolveWorktreeLaunchContextPreview({ agentDir }),
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
  const trimmedPrefix = prefix.trimStart();
  const iterm2Matches = getSessionDeckIterm2CommandCompletions(trimmedPrefix);

  if (trimmedPrefix.startsWith('iterm2')) {
    return iterm2Matches;
  }

  const flagMatches = COMMAND_FLAGS.filter((flag) => flag.startsWith(trimmedPrefix)).map(
    (flag) => ({
      value: flag,
      label: flag,
    }),
  );

  if (iterm2Matches === null) {
    return flagMatches.length > 0 ? flagMatches : null;
  }

  return [...flagMatches, ...iterm2Matches];
}

function getOpenTerminalForRuntimeOptions(
  options: RegisterSessionDeckCommandOptions,
): OpenTerminalForRuntimeOptions {
  return {
    ...(options.identityDirectory === undefined
      ? {}
      : { identityDirectory: options.identityDirectory }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };
}

function getTerminalDisplayHintOptions(
  options: RegisterSessionDeckCommandOptions,
): Pick<ReadSessionDeckBrowserSnapshotOptions, 'identityDirectory' | 'readdir' | 'readFile'> {
  return {
    ...(options.identityDirectory === undefined
      ? {}
      : { identityDirectory: options.identityDirectory }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };
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
