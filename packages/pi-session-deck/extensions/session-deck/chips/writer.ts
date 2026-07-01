/**
 * Chips writer: serialize + mkdir + temp file + atomic rename,
 * and clear-by-key for pi-session-deck chip records.
 */

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import {
  CHIP_DIAGNOSTIC_CODES,
  validateChipIdSlug,
  validateChipLevel,
  validateChipScope,
  validateSourceSlug,
} from './constants.js';
import {
  createChipTempPath,
  getChipRecordPath,
  getChipRuntimeDirectory,
  getChipsDirectory,
  resolveChipId,
  resolveChipScope,
} from './store.js';
import type { ChipDiagnosticSink, ChipScope, SessionDeckChipRecord } from './types.js';

export function serializeChipRecord(record: SessionDeckChipRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export interface WriteChipRecordOptions {
  directory?: string;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  rename?: typeof rename;
  createTempPath?: (
    source: string,
    chipId: string,
    scope: string,
    runtimeId: string,
    directory: string,
  ) => string;
  onDiagnostic?: ChipDiagnosticSink;
}

interface ClearChipRecordKey {
  source: string;
  chipId?: string;
  scope?: ChipScope;
  runtimeId?: string;
  sessionId?: string | null;
}

export interface ClearChipRecordOptions {
  directory?: string;
  rm?: typeof unlink;
  onDiagnostic?: ChipDiagnosticSink;
}

export async function writeChipRecord(
  record: SessionDeckChipRecord,
  options: WriteChipRecordOptions = {},
): Promise<string | null> {
  const emit = options.onDiagnostic ?? noopDiagnostic;

  const sourceValidation = validateSourceSlug(record.source);
  if (!sourceValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
    return null;
  }

  const chipIdValidation = validateChipIdSlug(record.chipId);
  if (!chipIdValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_ID_INVALID, chipIdValidation.reason);
    return null;
  }

  const scopeValidation = validateChipScope(record.scope);
  if (!scopeValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_SCOPE_INVALID, scopeValidation.reason);
    return null;
  }

  const levelValidation = validateChipLevel(record.level);
  if (!levelValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_LEVEL_INVALID, levelValidation.reason);
    return null;
  }

  if (!isNonEmptyString(record.runtimeId)) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING, 'runtimeId is required');
    return null;
  }

  if (scopeValidation.value === 'session' && !isNonEmptyString(record.sessionId)) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_SESSION_ID_MISSING,
      'session-scoped chips require a resolved sessionId',
    );
    return null;
  }

  if (scopeValidation.value === 'runtime' && record.sessionId !== null) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_SCOPE_INVALID,
      'runtime-scoped chips must store sessionId as null',
    );
    return null;
  }

  const chipsDir = options.directory ?? getChipsDirectory();
  const runtimeDir = getChipRuntimeDirectory(record.runtimeId, chipsDir);
  const mkdirImpl = options.mkdir ?? mkdir;
  const writeFileImpl = options.writeFile ?? writeFile;
  const renameImpl = options.rename ?? rename;
  const createTempPath = options.createTempPath ?? createChipTempPath;

  try {
    await mkdirImpl(runtimeDir, { recursive: true });

    const targetPath = getChipRecordPath(
      record.source,
      record.chipId,
      record.scope,
      record.runtimeId,
      chipsDir,
    );
    const tempPath = createTempPath(
      record.source,
      record.chipId,
      record.scope,
      record.runtimeId,
      chipsDir,
    );

    await writeFileImpl(tempPath, serializeChipRecord(record), 'utf8');
    await renameImpl(tempPath, targetPath);

    return targetPath;
  } catch (error) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_WRITE_ERROR,
      `Failed to write chip record: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

export async function clearChipRecord(
  key: ClearChipRecordKey,
  options: ClearChipRecordOptions = {},
): Promise<boolean> {
  const emit = options.onDiagnostic ?? noopDiagnostic;

  const sourceValidation = validateSourceSlug(key.source);
  if (!sourceValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
    return false;
  }

  const chipId = resolveChipId(key.chipId);
  const chipIdValidation = validateChipIdSlug(chipId);
  if (!chipIdValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_ID_INVALID, chipIdValidation.reason);
    return false;
  }

  if (key.scope !== undefined) {
    const scopeValidation = validateChipScope(key.scope);
    if (!scopeValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SCOPE_INVALID, scopeValidation.reason);
      return false;
    }
  }
  const scope = resolveChipScope(key.scope);

  const runtimeId = key.runtimeId;
  if (!isNonEmptyString(runtimeId)) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING, 'runtimeId is required');
    return false;
  }

  const chipsDir = options.directory ?? getChipsDirectory();
  const targetPath = getChipRecordPath(key.source, chipId, scope, runtimeId, chipsDir);
  const unlinkImpl = options.rm ?? unlink;

  try {
    await unlinkImpl(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_CLEAR_ERROR,
      `Failed to clear chip record: ${getErrorMessage(error)}`,
    );
    return false;
  }
}

function isNonEmptyString(candidate: string | null | undefined): candidate is string {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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
