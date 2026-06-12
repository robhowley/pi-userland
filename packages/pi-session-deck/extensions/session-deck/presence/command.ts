import { SESSION_DECK_PRESENCE_COMMAND_NAME } from './constants.js';
import { readPresenceView, type ReadPresenceViewOptions } from './reader.js';
import type { PresenceState, PresenceSummary, PresenceView } from './types.js';

export type PresenceCommandNotificationLevel = 'info' | 'warning' | 'error';

export interface PresenceCommandContext {
  ui: {
    notify: (message: string, level: PresenceCommandNotificationLevel) => void;
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

export interface RegisterPresenceCommandOptions extends ReadPresenceViewOptions {
  readPresenceView?: typeof readPresenceView;
}

export type ParsedPresenceCommandArgs =
  | {
      ok: true;
      all: boolean;
    }
  | {
      ok: false;
      message: string;
    };

const SHOW_ALL_FLAG = '--all';
const USAGE = `Usage: /${SESSION_DECK_PRESENCE_COMMAND_NAME} [${SHOW_ALL_FLAG}]`;
const DEFAULT_VISIBLE_STATES: PresenceState[] = ['live', 'stale'];

export function registerPresenceCommand(
  pi: PresenceCommandAPI,
  options: RegisterPresenceCommandOptions = {},
): void {
  const readPresence = options.readPresenceView ?? readPresenceView;

  pi.registerCommand(SESSION_DECK_PRESENCE_COMMAND_NAME, {
    description: 'Show Pi runtime presence from ~/.pi/session-deck/presence',
    getArgumentCompletions: getPresenceCommandCompletions,
    handler: async (args, ctx) => {
      const parsedArgs = parsePresenceCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.message, 'error');
        return;
      }

      const view = await readPresence({
        ...(options.directory === undefined ? {} : { directory: options.directory }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
        ...(options.inspectPid === undefined ? {} : { inspectPid: options.inspectPid }),
        ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
        ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
      });

      const visibleRecords = parsedArgs.all
        ? view.records
        : view.records.filter((record) => DEFAULT_VISIBLE_STATES.includes(record.presenceState));
      const visibleView: PresenceView = {
        records: visibleRecords,
        diagnostics: parsedArgs.all ? view.diagnostics : [],
      };

      ctx.ui.notify(renderPresenceView(visibleView, { all: parsedArgs.all }), 'info');
    },
  });
}

export function parsePresenceCommandArgs(args: string): ParsedPresenceCommandArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return { ok: true, all: false };
  }

  if (tokens.length === 1 && tokens[0] === SHOW_ALL_FLAG) {
    return { ok: true, all: true };
  }

  return { ok: false, message: USAGE };
}

export function renderPresenceView(view: PresenceView, options: { all: boolean }): string {
  const lines: string[] = [];

  if (view.records.length === 0) {
    lines.push(options.all ? 'No presence records found.' : 'No live or stale Pi runtimes found.');
  } else {
    lines.push(options.all ? 'Pi runtime presence' : 'Pi runtime presence (live + stale)');
    for (const record of view.records) {
      lines.push(formatPresenceSummary(record));
    }
  }

  if (options.all && view.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const diagnostic of view.diagnostics) {
      const location = diagnostic.filePath === undefined ? '' : ` (${diagnostic.filePath})`;
      lines.push(`- ${diagnostic.code}${location}: ${diagnostic.message}`);
    }
  }

  return lines.join('\n');
}

function getPresenceCommandCompletions(prefix: string) {
  return SHOW_ALL_FLAG.startsWith(prefix) ? [{ value: SHOW_ALL_FLAG, label: SHOW_ALL_FLAG }] : null;
}

function formatPresenceSummary(record: PresenceSummary): string {
  const reason = record.reason === undefined ? '' : ` reason=${record.reason}`;
  return [
    `- ${record.runtimeId}`,
    `state=${record.presenceState}`,
    `pid=${record.pid}`,
    `age=${formatDuration(record.heartbeatAgeMs)}`,
    `startedAt=${record.startedAt}`,
    `heartbeatAt=${record.heartbeatAt}${reason}`,
  ].join(' ');
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

export { SESSION_DECK_PRESENCE_COMMAND_NAME };
