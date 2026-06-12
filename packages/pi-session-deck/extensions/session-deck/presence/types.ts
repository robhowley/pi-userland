export interface PresenceRecord {
  runtimeId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export type PresenceState = 'live' | 'stale' | 'dead' | 'unknown';

export type PresenceStateReason =
  | 'fresh_heartbeat'
  | 'heartbeat_expired'
  | 'pid_missing'
  | 'pid_reused'
  | 'pid_unverified'
  | 'future_timestamp'
  | 'invalid_timestamp';

export interface PresenceSummary extends PresenceRecord {
  heartbeatAgeMs: number;
  presenceState: PresenceState;
  reason?: PresenceStateReason;
}

export type PresenceDiagnosticCode = 'malformed_record' | 'read_error' | 'write_error';

export interface PresenceDiagnostic {
  code: PresenceDiagnosticCode;
  message: string;
  filePath?: string;
}

export interface PresenceView {
  records: PresenceSummary[];
  diagnostics: PresenceDiagnostic[];
}

export interface PresenceThresholds {
  heartbeatIntervalMs: number;
  liveAfterMs: number;
  deadAfterMs: number;
  reapAfterMs: number;
  futureSkewMs: number;
  pidReuseGraceMs: number;
}

export type PidValidationStatus = 'matches' | 'missing' | 'reused' | 'unverified';

export interface PidValidationResult {
  status: PidValidationStatus;
  reason?: Extract<PresenceStateReason, 'pid_missing' | 'pid_reused' | 'pid_unverified'>;
  observedStartedAt?: string;
}

export type InspectPresencePid = (record: PresenceRecord) => Promise<PidValidationResult>;
