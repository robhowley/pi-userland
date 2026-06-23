import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHIPS_SCHEMA_VERSION,
  validateChipIdSlug,
  validateChipLevel,
  validateChipScope,
  validateSourceSlug,
} from './constants.js';
import { getChipsDirectory, isChipRecordFile } from './store.js';
import type { ChipDiagnostic, ChipScope } from './types.js';

export type ChipDirectoryReader = (
  path: string,
  options: { withFileTypes: true },
) => Promise<Dirent<string>[]>;

export type ChipFileReader = (path: string, encoding: 'utf8') => Promise<string>;

export interface SessionDeckChipJoinTarget {
  runtimeId: string;
  sessionId: string | null;
  sessionIdTrusted?: boolean;
}

export interface SessionDeckChipsRecord {
  runtimeId: string;
  chips: string[];
  diagnostics: ChipDiagnostic[];
}

export interface SessionDeckChipsView {
  records: SessionDeckChipsRecord[];
  diagnostics: ChipDiagnostic[];
}

export interface ReadSessionDeckChipsOptions {
  records: SessionDeckChipJoinTarget[];
  chipsDirectory?: string;
  now?: Date;
  readdir?: ChipDirectoryReader;
  readFile?: ChipFileReader;
}

interface NormalizedChipRecord {
  runtimeId: string;
  sessionId: string | null;
  source: string;
  chipId: string;
  scope: ChipScope;
  text: string;
  updatedAtMs: number;
  ttlMs: number | null;
}

interface ScannedChipRecords {
  recordsByRuntimeId: Map<string, NormalizedChipRecord[]>;
  diagnosticsByRuntimeId: Map<string, ChipDiagnostic[]>;
  diagnostics: ChipDiagnostic[];
}

export async function readSessionDeckChips(
  options: ReadSessionDeckChipsOptions,
): Promise<SessionDeckChipsView> {
  const directory = options.chipsDirectory ?? getChipsDirectory();
  const readdirImpl = (options.readdir ?? readdir) as ChipDirectoryReader;
  const readFileImpl = (options.readFile ?? readFile) as ChipFileReader;
  const nowMs = (options.now ?? new Date()).getTime();
  const scan = await scanChipRecords(directory, readdirImpl, readFileImpl);

  const records: SessionDeckChipsRecord[] = [];
  const diagnostics: ChipDiagnostic[] = [...scan.diagnostics];
  const matchedRuntimeIds = new Set<string>();

  for (const target of options.records) {
    matchedRuntimeIds.add(target.runtimeId);

    const runtimeRecords = sortChipRecords(scan.recordsByRuntimeId.get(target.runtimeId) ?? []);
    const runtimeDiagnostics = [
      ...(scan.diagnosticsByRuntimeId.get(target.runtimeId) ?? []),
      ...resolveRuntimeChipDiagnostics(runtimeRecords, target, nowMs),
    ];

    records.push({
      runtimeId: target.runtimeId,
      chips: resolveVisibleChips(runtimeRecords, target, nowMs),
      diagnostics: runtimeDiagnostics,
    });
    diagnostics.push(...runtimeDiagnostics);
  }

  const unmatchedRuntimeIds = new Set<string>([
    ...scan.recordsByRuntimeId.keys(),
    ...scan.diagnosticsByRuntimeId.keys(),
  ]);

  for (const runtimeId of Array.from(unmatchedRuntimeIds).sort()) {
    if (matchedRuntimeIds.has(runtimeId)) {
      continue;
    }

    diagnostics.push(...(scan.diagnosticsByRuntimeId.get(runtimeId) ?? []));

    for (const record of sortChipRecords(scan.recordsByRuntimeId.get(runtimeId) ?? [])) {
      diagnostics.push({
        code: 'orphan_chip',
        message: 'Chip record has no matching runtime row',
        runtimeId: record.runtimeId,
      });
    }
  }

  return { records, diagnostics };
}

async function scanChipRecords(
  directory: string,
  readdirImpl: ChipDirectoryReader,
  readFileImpl: ChipFileReader,
): Promise<ScannedChipRecords> {
  const recordsByRuntimeId = new Map<string, NormalizedChipRecord[]>();
  const diagnosticsByRuntimeId = new Map<string, ChipDiagnostic[]>();
  const diagnostics: ChipDiagnostic[] = [];

  let runtimeEntries: Dirent<string>[];
  try {
    runtimeEntries = await readdirImpl(directory, { withFileTypes: true });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      return { recordsByRuntimeId, diagnosticsByRuntimeId, diagnostics };
    }

    diagnostics.push({
      code: 'chip_read_error',
      message: `Failed to read chips directory: ${getErrorMessage(error)}`,
    });
    return { recordsByRuntimeId, diagnosticsByRuntimeId, diagnostics };
  }

  for (const runtimeEntry of sortEntriesByName(runtimeEntries)) {
    if (!runtimeEntry.isDirectory()) {
      continue;
    }

    const runtimeId = runtimeEntry.name;
    const runtimeDirectory = join(directory, runtimeId);

    let chipEntries: Dirent<string>[];
    try {
      chipEntries = await readdirImpl(runtimeDirectory, { withFileTypes: true });
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT') {
        pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
          code: 'chip_read_error',
          message: `Failed to read chip runtime directory: ${getErrorMessage(error)}`,
          runtimeId,
        });
      }
      continue;
    }

    for (const chipEntry of sortEntriesByName(chipEntries)) {
      if (!chipEntry.isFile() || !isChipRecordFile(chipEntry.name)) {
        continue;
      }

      const filePath = join(runtimeDirectory, chipEntry.name);

      let source: string;
      try {
        source = await readFileImpl(filePath, 'utf8');
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode !== 'ENOENT') {
          pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
            code: 'chip_read_error',
            message: `Failed to read chip record: ${getErrorMessage(error)}`,
            runtimeId,
          });
        }
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(source) as unknown;
      } catch (error) {
        pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
          code: 'malformed_chip_record',
          message: `Ignored malformed chip JSON: ${getErrorMessage(error)}`,
          runtimeId,
        });
        continue;
      }

      const record = normalizeChipRecord(parsed, runtimeId, chipEntry.name);
      if (record === null) {
        pushRuntimeDiagnostic(diagnosticsByRuntimeId, runtimeId, {
          code: 'malformed_chip_record',
          message: 'Ignored malformed chip record',
          runtimeId,
        });
        continue;
      }

      const existing = recordsByRuntimeId.get(runtimeId) ?? [];
      existing.push(record);
      recordsByRuntimeId.set(runtimeId, existing);
    }
  }

  return { recordsByRuntimeId, diagnosticsByRuntimeId, diagnostics };
}

function normalizeChipRecord(
  candidate: unknown,
  runtimeId: string,
  fileName: string,
): NormalizedChipRecord | null {
  if (!isObject(candidate)) {
    return null;
  }

  if (candidate['schemaVersion'] !== CHIPS_SCHEMA_VERSION) {
    return null;
  }

  const recordRuntimeId = candidate['runtimeId'];
  if (typeof recordRuntimeId !== 'string' || recordRuntimeId !== runtimeId) {
    return null;
  }

  const source = candidate['source'];
  if (typeof source !== 'string' || !validateSourceSlug(source).valid) {
    return null;
  }

  const chipId = candidate['chipId'];
  if (typeof chipId !== 'string' || !validateChipIdSlug(chipId).valid) {
    return null;
  }

  const scope = candidate['scope'];
  if (typeof scope !== 'string') {
    return null;
  }
  const scopeValidation = validateChipScope(scope);
  if (!scopeValidation.valid) {
    return null;
  }

  if (fileName !== `${source}.${chipId}.${scopeValidation.value}.json`) {
    return null;
  }

  const text = candidate['text'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const level = candidate['level'];
  if (typeof level !== 'string' || !validateChipLevel(level).valid) {
    return null;
  }

  const updatedAt = candidate['updatedAt'];
  if (typeof updatedAt !== 'string') {
    return null;
  }
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }

  const ttlMs = normalizeTtlMs(candidate['ttlMs']);
  if (ttlMs === undefined) {
    return null;
  }

  if (scopeValidation.value === 'runtime') {
    if (candidate['sessionId'] !== null) {
      return null;
    }
  }

  if (scopeValidation.value === 'session') {
    const sessionId = candidate['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return null;
    }
  }

  return {
    runtimeId,
    sessionId: scopeValidation.value === 'runtime' ? null : (candidate['sessionId'] as string),
    source,
    chipId,
    scope: scopeValidation.value,
    text: text.trim(),
    updatedAtMs,
    ttlMs,
  };
}

function normalizeTtlMs(value: unknown): number | null | undefined {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function resolveVisibleChips(
  records: NormalizedChipRecord[],
  target: SessionDeckChipJoinTarget,
  nowMs: number,
): string[] {
  return records
    .filter((record) => shouldIncludeChip(record, target, nowMs))
    .map((record) => record.text);
}

function resolveRuntimeChipDiagnostics(
  records: NormalizedChipRecord[],
  target: SessionDeckChipJoinTarget,
  nowMs: number,
): ChipDiagnostic[] {
  const diagnostics: ChipDiagnostic[] = [];

  for (const record of records) {
    if (isExpired(record, nowMs)) {
      diagnostics.push({
        code: 'chip_expired',
        message: 'Ignored expired chip record',
        runtimeId: target.runtimeId,
      });
      continue;
    }

    if (record.scope === 'session' && !hasMatchingSession(record, target)) {
      diagnostics.push({
        code: 'chip_session_mismatch',
        message:
          target.sessionIdTrusted === false || target.sessionId === null
            ? 'Ignored session-scoped chip because the current sessionId is missing or untrusted'
            : 'Ignored session-scoped chip from a different sessionId',
        runtimeId: target.runtimeId,
      });
    }
  }

  return diagnostics;
}

function shouldIncludeChip(
  record: NormalizedChipRecord,
  target: SessionDeckChipJoinTarget,
  nowMs: number,
): boolean {
  if (isExpired(record, nowMs)) {
    return false;
  }

  if (record.scope === 'runtime') {
    return true;
  }

  return hasMatchingSession(record, target);
}

function hasMatchingSession(
  record: NormalizedChipRecord,
  target: SessionDeckChipJoinTarget,
): boolean {
  return (
    record.scope !== 'session' ||
    (target.sessionIdTrusted !== false &&
      target.sessionId !== null &&
      record.sessionId === target.sessionId)
  );
}

function isExpired(record: NormalizedChipRecord, nowMs: number): boolean {
  return record.ttlMs !== null && record.updatedAtMs + record.ttlMs <= nowMs;
}

function sortChipRecords(records: NormalizedChipRecord[]): NormalizedChipRecord[] {
  return [...records].sort((left, right) => {
    const sourceOrder = left.source.localeCompare(right.source);
    if (sourceOrder !== 0) {
      return sourceOrder;
    }

    const chipIdOrder = left.chipId.localeCompare(right.chipId);
    if (chipIdOrder !== 0) {
      return chipIdOrder;
    }

    const scopeOrder = left.scope.localeCompare(right.scope);
    if (scopeOrder !== 0) {
      return scopeOrder;
    }

    return left.text.localeCompare(right.text);
  });
}

function sortEntriesByName(entries: Dirent<string>[]): Dirent<string>[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function pushRuntimeDiagnostic(
  diagnosticsByRuntimeId: Map<string, ChipDiagnostic[]>,
  runtimeId: string,
  diagnostic: ChipDiagnostic,
): void {
  const existing = diagnosticsByRuntimeId.get(runtimeId) ?? [];
  existing.push(diagnostic);
  diagnosticsByRuntimeId.set(runtimeId, existing);
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
