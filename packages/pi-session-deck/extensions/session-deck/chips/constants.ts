/**
 * Chips backend constants for pi-session-deck.
 *
 * Defines path segments, schema version, default values, validation helpers,
 * and the shared diagnostic code namespace for chip publish/write/clear paths.
 */

import type { ChipDiagnosticCode, ChipLevel, ChipScope } from './types.js';

export const CHIPS_PATH_SEGMENTS = ['.pi', 'session-deck', 'chips'] as const;

export const CHIPS_SCHEMA_VERSION = 1 as const;

export const DEFAULT_CHIP_ID = 'default' as const;
export const DEFAULT_CHIP_SCOPE: ChipScope = 'session';
export const DEFAULT_CHIP_LEVEL: ChipLevel = 'unknown';

export const ALLOWED_CHIP_SCOPES: readonly ChipScope[] = ['session', 'runtime'] as const;

export const ALLOWED_CHIP_LEVELS: readonly ChipLevel[] = [
  'ok',
  'info',
  'warn',
  'error',
  'unknown',
] as const;

export const MAX_CHIP_SLUG_LENGTH = 64;

const CHIP_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CHIP_SCOPE_VALUES = ALLOWED_CHIP_SCOPES as readonly string[];
const CHIP_LEVEL_VALUES = ALLOWED_CHIP_LEVELS as readonly string[];
const CHIP_SCOPE_LIST = ALLOWED_CHIP_SCOPES.join(', ');
const CHIP_LEVEL_LIST = ALLOWED_CHIP_LEVELS.join(', ');
const CHIP_SLUG_RULE =
  'must use lowercase ASCII letters, digits, and "-" only, start with a letter, not end with "-", and be at most 64 characters';

export type ChipValidationResult<T> = { valid: true; value: T } | { valid: false; reason: string };

export function isValidSourceSlug(source: string): boolean {
  return isValidChipSlug(source);
}

export function isValidChipIdSlug(chipId: string): boolean {
  return isValidChipSlug(chipId);
}

export function validateSourceSlug(source: string): ChipValidationResult<string> {
  if (source.length === 0) {
    return { valid: false, reason: 'source is required' };
  }

  if (!isValidSourceSlug(source)) {
    return {
      valid: false,
      reason: `source "${source}" ${CHIP_SLUG_RULE}`,
    };
  }

  return { valid: true, value: source };
}

export function validateChipIdSlug(chipId: string): ChipValidationResult<string> {
  if (chipId.length === 0) {
    return { valid: false, reason: 'chipId is required' };
  }

  if (!isValidChipIdSlug(chipId)) {
    return {
      valid: false,
      reason: `chipId "${chipId}" ${CHIP_SLUG_RULE}`,
    };
  }

  return { valid: true, value: chipId };
}

export function resolveChipId(candidate: string | undefined): string {
  return candidate ?? DEFAULT_CHIP_ID;
}

export function isChipScope(candidate: unknown): candidate is ChipScope {
  return typeof candidate === 'string' && CHIP_SCOPE_VALUES.includes(candidate);
}

export function validateChipScope(scope: string): ChipValidationResult<ChipScope> {
  if (!isChipScope(scope)) {
    return {
      valid: false,
      reason: `scope "${scope}" must be one of: ${CHIP_SCOPE_LIST}`,
    };
  }

  return { valid: true, value: scope };
}

export function resolveChipScope(candidate: ChipScope | undefined): ChipScope {
  return candidate ?? DEFAULT_CHIP_SCOPE;
}

export function isChipLevel(candidate: unknown): candidate is ChipLevel {
  return typeof candidate === 'string' && CHIP_LEVEL_VALUES.includes(candidate);
}

export function validateChipLevel(level: string): ChipValidationResult<ChipLevel> {
  if (!isChipLevel(level)) {
    return {
      valid: false,
      reason: `level "${level}" must be one of: ${CHIP_LEVEL_LIST}`,
    };
  }

  return { valid: true, value: level };
}

export function resolveChipLevel(candidate: string | undefined): ChipLevel {
  if (candidate === undefined) {
    return DEFAULT_CHIP_LEVEL;
  }

  const normalized = candidate.trim().toLowerCase();
  return isChipLevel(normalized) ? normalized : DEFAULT_CHIP_LEVEL;
}

export const CHIP_DIAGNOSTIC_CODES = {
  CHIP_SOURCE_INVALID: 'chip_source_invalid',
  CHIP_ID_INVALID: 'chip_id_invalid',
  CHIP_LEVEL_INVALID: 'chip_level_invalid',
  CHIP_TEXT_EMPTY: 'chip_text_empty',
  CHIP_UPDATED_AT_MISSING: 'chip_updated_at_missing',
  CHIP_UPDATED_AT_FUTURE: 'chip_updated_at_future',
  CHIP_WRITE_ERROR: 'chip_write_error',
  CHIP_CLEAR_ERROR: 'chip_clear_error',
  CHIP_SCOPE_INVALID: 'chip_scope_invalid',
  CHIP_RUNTIME_ID_MISSING: 'chip_runtime_id_missing',
  CHIP_SESSION_ID_MISSING: 'chip_session_id_missing',
} as const satisfies Record<string, ChipDiagnosticCode>;

export type ChipDiagnosticCodeKey = keyof typeof CHIP_DIAGNOSTIC_CODES;

function isValidChipSlug(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    candidate.length <= MAX_CHIP_SLUG_LENGTH &&
    CHIP_SLUG_PATTERN.test(candidate) &&
    !candidate.endsWith('-')
  );
}
