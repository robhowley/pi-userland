import { basename } from 'node:path';
import { readSessionDeckView, type ReadSessionDeckViewOptions } from '../activity/reader.js';
import type {
  SessionDeckDiagnostic,
  SessionDeckRecord,
  SessionDeckView,
} from '../activity/types.js';
import { SESSION_DECK_COMMAND_NAME } from '../presence/constants.js';
import { reapPresenceRecords, type ReapPresenceRecordsOptions } from '../presence/reap.js';
import { readPresenceView, type ReadPresenceViewOptions } from '../presence/reader.js';
import { readJoinedSessionView, type ReadJoinedSessionViewOptions } from './reader.js';
import type { PresenceDiagnostic, PresenceState, PresenceView } from '../presence/types.js';

export interface PresenceCommandContext {
  ui: {
    notify: (message: string, level: 'info' | 'warning' | 'error') => void;
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

export interface RegisterSessionDeckCommandOptions extends ReadPresenceViewOptions {
  identityDirectory?: string;
  activityDirectory?: string;
  identityFreshnessThresholds?: Partial<import('./types.js').IdentityFreshnessThresholds>;
  activityThresholds?: Partial<import('../activity/types.js').ActivityThresholds>;
  readPresenceView?: typeof readPresenceView;
  readJoinedSessionView?: typeof readJoinedSessionView;
  readSessionDeckView?: typeof readSessionDeckView;
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
  const readPresence = options.readPresenceView ?? readPresenceView;
  const readJoined = options.readJoinedSessionView ?? readJoinedSessionView;
  const readSessionDeck = options.readSessionDeckView ?? readSessionDeckView;
  const reapPresence = options.reapPresenceRecords ?? reapPresenceRecords;

  pi.registerCommand(SESSION_DECK_COMMAND_NAME, {
    description: 'Show Pi session presence, identity, and activity from ~/.pi/session-deck',
    getArgumentCompletions: getSessionDeckCommandCompletions,
    handler: async (args: string, ctx: PresenceCommandContext) => {
      const parsedArgs = parseSessionDeckCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.message, 'error');
        return;
      }

      const reapResult = parsedArgs.reap ? await reapPresence(getReapOptions(options)) : null;
      const presenceView = await readPresence(getReadPresenceOptions(options));
      const joinedView = await readJoined(getReadJoinedOptions(options, presenceView));
      const sessionDeckView = await readSessionDeck(getReadSessionDeckOptions(options, joinedView));

      const visibleRecords = parsedArgs.all
        ? sessionDeckView.records
        : sessionDeckView.records.filter((record) =>
            DEFAULT_VISIBLE_STATES.includes(record.presenceState as PresenceState),
          );
      const visibleView: SessionDeckView = {
        records: visibleRecords,
        diagnostics: parsedArgs.all ? sessionDeckView.diagnostics : [],
      };

      const message =
        reapResult === null
          ? renderSessionDeckView(visibleView, {
              all: parsedArgs.all,
              showIdentity: parsedArgs.identity,
            })
          : renderSessionDeckCommandResult(visibleView, {
              all: parsedArgs.all,
              showIdentity: parsedArgs.identity,
              reapResult,
            });

      ctx.ui.notify(message, 'info');
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
  view: SessionDeckView,
  options: { all: boolean; showIdentity: boolean },
): string {
  const lines: string[] = [];

  if (view.records.length === 0) {
    lines.push(options.all ? 'No session records found.' : 'No live or stale Pi sessions found.');
  } else {
    lines.push(options.all ? 'Pi sessions (all records)' : 'Pi sessions (live + stale)');
    for (const record of view.records) {
      lines.push(formatSessionDeckRecord(record, options));
    }
  }

  if (options.all && view.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const diagnostic of view.diagnostics) {
      lines.push(formatSessionDeckDiagnostic(diagnostic));
    }
  }

  return lines.join('\n');
}

function renderSessionDeckCommandResult(
  view: SessionDeckView,
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

function formatReapSummary(removedCount: number): string {
  return `Reap complete: removed ${removedCount} expired presence ${pluralize(
    removedCount,
    'record',
  )}.`;
}

function formatReapedRecord(filePath: string): string {
  const runtimeId = basename(filePath, '.json');
  return runtimeId.length > 0 ? runtimeId : filePath;
}

function formatPresenceDiagnostic(diagnostic: PresenceDiagnostic): string {
  const location = diagnostic.filePath === undefined ? '' : ` (${diagnostic.filePath})`;
  return `- ${diagnostic.code}${location}: ${diagnostic.message}`;
}

function formatSessionDeckDiagnostic(diagnostic: SessionDeckDiagnostic): string {
  const location =
    diagnostic.runtimeId !== undefined
      ? ` runtime=${diagnostic.runtimeId}`
      : diagnostic.filePath !== undefined
        ? ` (${diagnostic.filePath})`
        : '';
  return `- ${diagnostic.code}${location}: ${diagnostic.message}`;
}

function formatSessionDeckRecord(
  record: SessionDeckRecord,
  options: { all: boolean; showIdentity: boolean },
): string {
  const parts: string[] = [`- ${record.runtimeId}`];

  parts.push(`activity=${formatActivitySummary(record)}`);
  parts.push(`presence=${record.presenceState}`);
  parts.push(`pid=${record.pid}`);
  parts.push(`age=${formatDuration(record.heartbeatAgeMs)}`);

  if (record.cwd !== null) {
    parts.push(`cwd=${shortenHomePath(record.cwd)}`);
  }

  if (record.branch !== null) {
    parts.push(`branch=${record.branch}`);
  }

  if (record.prUrl !== null) {
    const prMatch = record.prUrl.match(/\/pull\/(\d+)$/);
    parts.push(prMatch ? `pr=#${prMatch[1]}` : `pr=${record.prUrl}`);
  }

  if (record.sessionId !== null && options.showIdentity) {
    parts.push(`session=${record.sessionId.slice(0, 8)}`);
  }

  if (record.identityFreshness !== 'missing' && options.showIdentity) {
    parts.push(`identity=${record.identityFreshness}`);
  }

  if (record.presenceReason !== undefined) {
    parts.push(`reason=${record.presenceReason}`);
  }

  if (options.all && record.diagnostics.length > 0) {
    for (const diagnostic of record.diagnostics) {
      parts.push(`[${diagnostic.code}]`);
    }
  }

  return parts.join('  ');
}

function formatActivitySummary(record: SessionDeckRecord): string {
  switch (record.activityState) {
    case 'waiting':
      return 'waiting';
    case 'thinking':
      return record.activityAgeMs === null
        ? 'thinking'
        : `thinking ${formatDuration(record.activityAgeMs)}`;
    case 'tool-running': {
      const toolName = record.currentToolName === null ? '' : `: ${record.currentToolName}`;
      const age = record.activityAgeMs === null ? '' : ` ${formatDuration(record.activityAgeMs)}`;
      return `tool-running${toolName}${age}`;
    }
    case 'error':
      return record.lastError === null ? 'error' : `error: ${record.lastError}`;
    case 'unknown': {
      const diagnostics = record.diagnostics
        .map((diagnostic) => diagnostic.code)
        .filter((code) =>
          [
            'activity_missing',
            'activity_stale',
            'session_mismatch',
            'busy_idle_conflict',
            'turn_started_missing',
            'tool_name_missing',
            'tool_stuck',
            'last_event_missing',
            'last_event_future',
            'malformed_activity_record',
            'activity_write_error',
            'activity_read_error',
          ].includes(code),
        );
      const suffix = diagnostics.length === 0 ? '' : ` [${diagnostics.join(',')}]`;
      return `unknown${suffix}`;
    }
  }
}

function shortenHomePath(cwd: string): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (home.length > 0 && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 'n/a';
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }

  if (durationMs < 60 * 60_000) {
    return `${Math.round(durationMs / 60_000)}m`;
  }

  return `${Math.round(durationMs / (60 * 60_000))}h`;
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

function getReadPresenceOptions(
  options: RegisterSessionDeckCommandOptions,
): ReadPresenceViewOptions {
  return {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.inspectPid === undefined ? {} : { inspectPid: options.inspectPid }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };
}

function getReadJoinedOptions(
  options: RegisterSessionDeckCommandOptions,
  presenceView: PresenceView,
): ReadJoinedSessionViewOptions {
  return {
    presenceView,
    ...(options.identityDirectory === undefined
      ? {}
      : { identityDirectory: options.identityDirectory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.identityFreshnessThresholds === undefined
      ? {}
      : { identityFreshnessThresholds: options.identityFreshnessThresholds }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };
}

function getReadSessionDeckOptions(
  options: RegisterSessionDeckCommandOptions,
  joinedView: import('./types.js').JoinedSessionView,
): ReadSessionDeckViewOptions {
  return {
    joinedView,
    ...(options.activityDirectory === undefined
      ? {}
      : { activityDirectory: options.activityDirectory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.activityThresholds === undefined ? {} : { thresholds: options.activityThresholds }),
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
