import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSessionTerminalMetadata } from './identity/metadata.js';
import { getDefaultIdentityDirectory, isIdentityRecordFile } from './identity/store.js';
import type { IdentityDirectoryReader, IdentityFileReader } from './identity/reader.js';
import type { SessionTerminalMetadata } from './identity/types.js';
import { toPublicSessionDeckDiagnostic, toPublicSessionDeckRecord } from './public-record.js';
import { readSessionDeckSnapshot, type ReadSessionDeckSnapshotOptions } from './reader.js';
import type { SessionDeckRecord, SessionDeckSnapshot } from './types.js';

export interface SessionDeckTerminalDisplayHint {
  kind: 'tmux';
  title?: string;
  detail: string;
  openLabel: string;
}

export interface SessionDeckBrowserRecord extends SessionDeckRecord {
  terminalDisplay?: SessionDeckTerminalDisplayHint;
}

export interface SessionDeckBrowserSnapshot extends Omit<SessionDeckSnapshot, 'records'> {
  records: SessionDeckBrowserRecord[];
}

export interface ReadSessionDeckBrowserSnapshotOptions extends ReadSessionDeckSnapshotOptions {
  readSessionDeckSnapshot?: typeof readSessionDeckSnapshot;
}

export async function readSessionDeckBrowserSnapshot(
  options: ReadSessionDeckBrowserSnapshotOptions = {},
): Promise<SessionDeckBrowserSnapshot> {
  const { readSessionDeckSnapshot: readSnapshot = readSessionDeckSnapshot, ...snapshotOptions } =
    options;
  return withTerminalDisplayHints(await readSnapshot(snapshotOptions), options);
}

export async function withTerminalDisplayHints(
  snapshot: SessionDeckSnapshot,
  options: Pick<
    ReadSessionDeckBrowserSnapshotOptions,
    'identityDirectory' | 'readdir' | 'readFile'
  > = {},
): Promise<SessionDeckBrowserSnapshot> {
  const hintsByRuntimeId = await readTerminalDisplayHints(options);
  return {
    generatedAt: snapshot.generatedAt,
    records: snapshot.records.map((record) => {
      const publicRecord = toPublicSessionDeckRecord(record);
      const hint = hintsByRuntimeId.get(record.runtimeId);
      return hint === undefined ? publicRecord : { ...publicRecord, terminalDisplay: hint };
    }),
    diagnostics: snapshot.diagnostics.map(toPublicSessionDeckDiagnostic),
  };
}

export function createTerminalDisplayHint(
  terminal: SessionTerminalMetadata,
): SessionDeckTerminalDisplayHint | undefined {
  if (terminal.kind !== 'tmux') {
    return undefined;
  }

  const context =
    terminal.windowName === undefined
      ? terminal.sessionName
      : `${terminal.sessionName}:${terminal.windowName}`;
  const detail = ['tmux', context, terminal.paneId].filter(isNonEmptyString).join(' ');

  return {
    kind: 'tmux',
    ...(terminal.windowName === undefined ? {} : { title: terminal.windowName }),
    detail,
    openLabel: 'new iTerm2 tab attaches to tmux',
  };
}

async function readTerminalDisplayHints(
  options: Pick<
    ReadSessionDeckBrowserSnapshotOptions,
    'identityDirectory' | 'readdir' | 'readFile'
  >,
): Promise<Map<string, SessionDeckTerminalDisplayHint>> {
  const directory = options.identityDirectory ?? getDefaultIdentityDirectory();
  const readdirImpl = (options.readdir ?? readdir) as IdentityDirectoryReader;
  const readFileImpl = (options.readFile ?? readFile) as IdentityFileReader;
  const hints = new Map<string, SessionDeckTerminalDisplayHint>();

  let entries: Dirent<string>[];
  try {
    entries = await readdirImpl(directory, { withFileTypes: true });
  } catch {
    return hints;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isIdentityRecordFile(entry.name)) {
      continue;
    }

    const runtimeId = entry.name.replace(/\.json$/, '');
    const filePath = join(directory, entry.name);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFileImpl(filePath, 'utf8')) as unknown;
    } catch {
      continue;
    }

    if (!isObject(parsed) || parsed['runtimeId'] !== runtimeId) {
      continue;
    }

    const terminal = normalizeSessionTerminalMetadata(parsed['terminal']);
    const hint = terminal === undefined ? undefined : createTerminalDisplayHint(terminal);
    if (hint !== undefined) {
      hints.set(runtimeId, hint);
    }
  }

  return hints;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}
