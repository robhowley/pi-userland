/**
 * Chips publisher: narrow public API for source packages to publish and clear
 * chip records without hand-rolling paths or atomic writes.
 */

import { getPresenceRuntimeIdentity } from '../presence/runtime.js';
import {
  CHIP_DIAGNOSTIC_CODES,
  CHIPS_SCHEMA_VERSION,
  resolveChipId,
  resolveChipLevel,
  resolveChipScope,
  validateChipIdSlug,
  validateChipScope,
  validateSourceSlug,
} from './constants.js';
import type {
  ClearSessionDeckChipKey,
  PublishSessionDeckChipInput,
  PublishSessionDeckChipOptions,
  SessionDeckChipRecord,
} from './types.js';
import { clearChipRecord, writeChipRecord } from './writer.js';

export async function publishSessionDeckChip(
  input: PublishSessionDeckChipInput,
  options: PublishSessionDeckChipOptions = {},
): Promise<string | null> {
  const emit = options.onDiagnostic ?? noopDiagnostic;

  const sourceValidation = validateSourceSlug(input.source);
  if (!sourceValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_SOURCE_INVALID, sourceValidation.reason);
    return null;
  }

  const chipId = resolveChipId(input.chipId);
  const chipIdValidation = validateChipIdSlug(chipId);
  if (!chipIdValidation.valid) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_ID_INVALID, chipIdValidation.reason);
    return null;
  }

  if (input.scope !== undefined) {
    const scopeValidation = validateChipScope(input.scope);
    if (!scopeValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SCOPE_INVALID, scopeValidation.reason);
      return null;
    }
  }
  const scope = resolveChipScope(input.scope);

  const runtimeId = resolveRuntimeId(input.runtimeId);
  if (runtimeId === null) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING, 'no runtimeId available');
    return null;
  }

  const sessionId = resolveSessionId(scope, input.sessionId, options.sessionManager);
  if (scope === 'session' && sessionId === null) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_SESSION_ID_MISSING,
      'session-scoped chips require a resolved sessionId',
    );
    return null;
  }

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length === 0) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_TEXT_EMPTY, 'text is required and must be non-empty');
    return null;
  }

  const level = resolveChipLevel(input.level);
  const normalizedLevelInput =
    typeof input.level === 'string' ? input.level.trim().toLowerCase() : undefined;
  if (normalizedLevelInput !== undefined && normalizedLevelInput !== level) {
    emit(
      CHIP_DIAGNOSTIC_CODES.CHIP_LEVEL_INVALID,
      `level "${input.level}" invalid; using "unknown"`,
    );
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_UPDATED_AT_MISSING, 'updatedAt could not be parsed');
    return null;
  }

  if (updatedAtMs > Date.now() + 5_000) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_UPDATED_AT_FUTURE, `updatedAt ${updatedAt} is in the future`);
    return null;
  }

  const record: SessionDeckChipRecord = {
    schemaVersion: CHIPS_SCHEMA_VERSION,
    runtimeId,
    sessionId,
    source: input.source,
    chipId,
    scope,
    text,
    level,
    updatedAt,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  };

  return writeChipRecord(record, {
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    onDiagnostic: emit,
  });
}

export async function clearSessionDeckChip(
  key: ClearSessionDeckChipKey,
  options: PublishSessionDeckChipOptions = {},
): Promise<boolean> {
  const emit = options.onDiagnostic ?? noopDiagnostic;

  if (key.scope !== undefined) {
    const scopeValidation = validateChipScope(key.scope);
    if (!scopeValidation.valid) {
      emit(CHIP_DIAGNOSTIC_CODES.CHIP_SCOPE_INVALID, scopeValidation.reason);
      return false;
    }
  }

  const runtimeId = resolveRuntimeId(key.runtimeId);
  if (runtimeId === null) {
    emit(CHIP_DIAGNOSTIC_CODES.CHIP_RUNTIME_ID_MISSING, 'no runtimeId available for clear');
    return false;
  }

  return clearChipRecord(
    {
      ...key,
      chipId: resolveChipId(key.chipId),
      runtimeId,
      scope: resolveChipScope(key.scope),
    },
    {
      ...(options.directory === undefined ? {} : { directory: options.directory }),
      onDiagnostic: emit,
    },
  );
}

function resolveRuntimeId(candidate: string | undefined): string | null {
  if (candidate !== undefined) {
    return candidate.trim().length > 0 ? candidate : null;
  }

  const runtimeId = getPresenceRuntimeIdentity().runtimeId;
  return runtimeId.trim().length > 0 ? runtimeId : null;
}

function resolveSessionId(
  scope: SessionDeckChipRecord['scope'],
  explicitSessionId: string | null | undefined,
  sessionManager?: { getSessionId(): string | null },
): string | null {
  if (scope !== 'session') {
    return null;
  }

  const candidate = explicitSessionId ?? sessionManager?.getSessionId() ?? null;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
}

function noopDiagnostic(_code: string, _message: string): void {
  // intentionally empty
}
