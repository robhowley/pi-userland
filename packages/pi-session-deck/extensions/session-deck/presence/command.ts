import { basename } from 'node:path';
import { SESSION_DECK_COMMAND_NAME } from './constants.js';
import {
  reapPresenceRecords,
  type ReapPresenceRecordsOptions,
  type ReapPresenceRecordsResult,
} from './reap.js';
import { readPresenceView, type ReadPresenceViewOptions } from './reader.js';
import type {
  PresenceDiagnostic,
  PresenceState,
  PresenceSummary,
  PresenceView,
} from './types.js';

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
  reapPresenceRecords?: typeof reapPresenceRecords;
  unlink?: ReapPresenceRecordsOptions['unlink'];
}

export type ParsedPresenceCommandArgs =
  | {
      ok: true;
      all: boolean;
      reap: boolean;
    }
  | {
      ok: false;
      message: string;
    };

const SHOW_ALL_FLAG = '--all';
const REAP_FLAG = '--reap';
const USAGE = `Usage: /${SESSION_DECK_COMMAND_NAME} [${SHOW_ALL_FLAG}] [${REAP_FLAG}]`;
const DEFAULT_VISIBLE_STATES: PresenceState[] = ['live', 'stale'];
const COMMAND_FLAGS = [SHOW_ALL_FLAG, REAP_FLAG] as const;

export function registerPresenceCommand(
  pi: PresenceCommandAPI,
  options: RegisterPresenceCommandOptions = {},
): void {
  const readPresence = options.readPresenceView ?? readPresenceView;
  const reapPresence = options.reapPresenceRecords ?? reapPresenceRecords;

  pi.registerCommand(SESSION_DECK_COMMAND_NAME, {
    description: 'Show Pi runtime presence from ~/.pi/session-deck/presence',
    getArgumentCompletions: getPresenceCommandCompletions,
    handler: async (args, ctx) => {
      const parsedArgs = parsePresenceCommandArgs(args);
      if (!parsedArgs.ok) {
        ctx.ui.notify(parsedArgs.message, 'error');
        return;
      }

      const reapResult = parsedArgs.reap
        ? await reapPresence(getReapPresenceOptions(options))
        : null;
      const view = await readPresence(getReadPresenceOptions(options));
      const visibleRecords = parsedArgs.all
        ? view.records
        : view.records.filter((record) => DEFAULT_VISIBLE_STATES.includes(record.presenceState));
      const visibleView: PresenceView = {
        records: visibleRecords,
        diagnostics: parsedArgs.all ? view.diagnostics : [],
      };

      const message =
        reapResult === null
          ? renderPresenceView(visibleView, { all: parsedArgs.all })
          : renderPresenceCommandResult(visibleView, {
              all: parsedArgs.all,
              reapResult,
            });

      ctx.ui.notify(message, 'info');
    },
  });
}

export function parsePresenceCommandArgs(args: string): ParsedPresenceCommandArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  let all = false;
  let reap = false;

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

    return { ok: false, message: USAGE };
  }

  return { ok: true, all, reap };
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
      lines.push(formatDiagnostic(diagnostic));
    }
  }

  return lines.join('\n');
}

function renderPresenceCommandResult(
  view: PresenceView,
  options: { all: boolean; reapResult: ReapPresenceRecordsResult },
): string {
  return [
    ...renderReapResult(options.reapResult),
    '',
    renderPresenceView(view, { all: options.all }),
  ].join('\n');
}

function renderReapResult(result: ReapPresenceRecordsResult): string[] {
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
      lines.push(formatDiagnostic(diagnostic));
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

function formatDiagnostic(diagnostic: PresenceDiagnostic): string {
  const location = diagnostic.filePath === undefined ? '' : ` (${diagnostic.filePath})`;
  return `- ${diagnostic.code}${location}: ${diagnostic.message}`;
}

function getPresenceCommandCompletions(prefix: string) {
  const matches = COMMAND_FLAGS.filter((flag) => flag.startsWith(prefix)).map((flag) => ({
    value: flag,
    label: flag,
  }));

  return matches.length > 0 ? matches : null;
}

function getReadPresenceOptions(options: RegisterPresenceCommandOptions): ReadPresenceViewOptions {
  return {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.inspectPid === undefined ? {} : { inspectPid: options.inspectPid }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  };
}

function getReapPresenceOptions(options: RegisterPresenceCommandOptions): ReapPresenceRecordsOptions {
  return {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.unlink === undefined ? {} : { unlink: options.unlink }),
  };
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

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export { SESSION_DECK_COMMAND_NAME };
