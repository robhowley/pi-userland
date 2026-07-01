/**
 * Chips backend types for pi-session-deck.
 *
 * Defines chip record shape, diagnostic types, and shared enums.
 */

export type ChipScope = 'session' | 'runtime';

export type ChipLevel = 'ok' | 'info' | 'warn' | 'error' | 'unknown';

export type ChipDiagnosticCode =
  | 'chip_source_invalid'
  | 'chip_id_invalid'
  | 'chip_level_invalid'
  | 'chip_write_error'
  | 'chip_clear_error'
  | 'chip_scope_invalid'
  | 'chip_runtime_id_missing'
  | 'chip_session_id_missing'
  | 'chip_mirror_error'
  | 'chip_read_error'
  | 'malformed_chip_record'
  | 'orphan_chip'
  | 'chip_session_mismatch'
  | 'chip_expired';

export interface ChipDiagnostic {
  code: ChipDiagnosticCode;
  message: string;
  runtimeId?: string;
  source?: string;
  chipId?: string;
  filePath?: string;
}

export interface SessionDeckChipRecord {
  schemaVersion: 1;
  runtimeId: string;
  sessionId: string | null;
  source: string;
  chipId: string;
  scope: 'session' | 'runtime';
  text: string;
  level: 'ok' | 'info' | 'warn' | 'error' | 'unknown';
  updatedAt: string;
  ttlMs?: number;
}

export type ChipDiagnosticSink = (code: ChipDiagnosticCode, message: string) => void;
