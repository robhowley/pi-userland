/**
 * Chips backend types for pi-session-deck.
 *
 * Defines chip record shape, publish/clear input contracts,
 * diagnostic types, and shared code enums.
 */

export type ChipScope = 'session' | 'runtime';

export type ChipLevel = 'ok' | 'info' | 'warn' | 'error' | 'unknown';

// ─── Shared diagnostic codes ────────────────────────────────────────
// These are the canonical diagnostic codes used by both publisher
// and reader modules. No module should invent its own prefix.

export type ChipDiagnosticCode =
  | 'chip_source_invalid'
  | 'chip_id_invalid'
  | 'chip_level_invalid'
  | 'chip_text_empty'
  | 'chip_updated_at_missing'
  | 'chip_updated_at_future'
  | 'chip_write_error'
  | 'chip_clear_error'
  | 'chip_scope_invalid'
  | 'chip_runtime_id_missing'
  | 'chip_session_id_missing';

export interface ChipDiagnostic {
  code: ChipDiagnosticCode;
  message: string;
  source?: string;
  chipId?: string;
  filePath?: string;
}

// ─── On-disk record (persisted only) ────────────────────────────────
// One record = one current-state chip file.
// No history, no tombstones.

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

// ─── Publish API input ──────────────────────────────────────────────
// Narrow helper boundary so source packages do not hand-roll
// paths or atomic writes.

export interface PublishSessionDeckChipInput {
  /** Defaults to the active presence runtimeId when omitted */
  runtimeId?: string;
  /** Resolved from sessionManager when scope=session */
  sessionId?: string | null;
  /** Package name identifier (must pass slug validation) */
  source: string;
  /** Defaults to 'default' */
  chipId?: string;
  /** Defaults to 'session' */
  scope?: ChipScope;
  /** The chip text / status message */
  text: string;
  /** Defaults to 'unknown'. Invalid values coerce to 'unknown'. */
  level?: ChipLevel;
  /** Defaults to now() ISO string when omitted */
  updatedAt?: string;
  /** Source-declared TTL for the consumer to consider as hard expiry */
  ttlMs?: number;
}

export interface PublishSessionDeckChipOptions {
  /** Used to resolve current sessionId for session-scoped chips */
  sessionManager?: { getSessionId(): string | null };
  /** Override the base chips directory (defaults to ~/.pi/session-deck/chips) */
  directory?: string;
  /** Diagnostic callback for fail-open messages */
  onDiagnostic?: (code: ChipDiagnosticCode, message: string) => void;
}

export interface ClearSessionDeckChipKey {
  source: string;
  chipId?: string;
  scope?: ChipScope;
  runtimeId?: string;
  sessionId?: string | null;
}

export type ChipDiagnosticSink = (code: ChipDiagnosticCode, message: string) => void;
