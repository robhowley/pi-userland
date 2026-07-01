import type {
  JoinedDiagnostic,
  JoinedSessionRecord,
  JoinedSessionView,
  SessionManagerLike,
} from '../identity/types.js';

export type ActivityState = 'idle' | 'thinking' | 'tool-running' | 'error' | 'unknown';

export type ActivitySource =
  | 'startup'
  | 'new'
  | 'message_end'
  | 'turn_start'
  | 'tool_start'
  | 'tool_end'
  | 'turn_end'
  | 'assistant_error'
  | 'periodic';

export interface SessionActivityRecord {
  runtimeId: string;
  sessionId: string | null;
  activityState: ActivityState;
  idle: boolean;
  busy: boolean;
  currentTurnStartedAt: string | null;
  currentToolName: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  lastUserTurnAt?: string;
  lastAssistantTurnAt?: string;
  lastToolStartedAt?: string;
  lastToolEndedAt?: string;
  lastErrorAt?: string;
  activityUpdatedAt?: string;
  activitySource?: ActivitySource;
}

export type ActivityDiagnosticCode =
  | 'activity_missing'
  | 'activity_stale'
  | 'session_mismatch'
  | 'busy_idle_conflict'
  | 'turn_started_missing'
  | 'tool_name_missing'
  | 'tool_stuck'
  | 'last_event_missing'
  | 'last_event_future'
  | 'last_error_active'
  | 'malformed_activity_record'
  | 'activity_write_error'
  | 'activity_read_error';

export interface ActivityDiagnostic {
  code: ActivityDiagnosticCode;
  message: string;
  runtimeId?: string;
  filePath?: string;
}

export interface ActivityThresholds {
  freshAfterMs: number;
  staleAfterMs: number;
  toolStuckAfterMs: number;
  veryStaleAfterMs: number;
  futureSkewMs: number;
}

export interface ActivityMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string | null;
}

export interface ActivityRuntimeController {
  refreshActivity: (
    source: 'startup' | 'new',
    sessionManager?: SessionManagerLike,
  ) => Promise<void>;
  recordMessageEnd: (message: ActivityMessageLike) => Promise<void>;
  recordTurnStart: () => Promise<void>;
  recordToolExecutionStart: (event: { toolCallId: string; toolName: string }) => Promise<void>;
  recordToolExecutionEnd: (event: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
  }) => Promise<void>;
  recordTurnEnd: () => Promise<void>;
  getActivity: () => SessionActivityRecord | null;
  isRunning: () => boolean;
}

export type SessionDeckDiagnosticCode = JoinedDiagnostic['code'] | ActivityDiagnosticCode;

export interface SessionDeckDiagnostic {
  code: SessionDeckDiagnosticCode;
  message: string;
  runtimeId?: string;
  filePath?: string;
}

export interface SessionDeckRecord extends Omit<JoinedSessionRecord, 'diagnostics'> {
  activityState: ActivityState;
  activityAgeMs: number | null;
  idle: boolean | null;
  busy: boolean | null;
  currentTurnStartedAt: string | null;
  currentToolName: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  activityUpdatedAt: string | null;
  diagnostics: SessionDeckDiagnostic[];
}

export interface SessionDeckView extends Omit<JoinedSessionView, 'records' | 'diagnostics'> {
  records: SessionDeckRecord[];
  diagnostics: SessionDeckDiagnostic[];
}

export interface DerivedActivity {
  activityState: ActivityState;
  activityAgeMs: number | null;
  idle: boolean | null;
  busy: boolean | null;
  currentTurnStartedAt: string | null;
  currentToolName: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  activityUpdatedAt: string | null;
  diagnostics: ActivityDiagnostic[];
}
