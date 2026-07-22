import type {
  JoinedDiagnostic,
  JoinedSessionRecord,
  JoinedSessionView,
  SessionManagerLike,
} from '../identity/types.js';

export type ActivityState =
  | 'idle'
  | 'thinking'
  | 'tool-running'
  | 'compacting'
  | 'error'
  | 'unknown';

export type ActivityInputSource = 'interactive' | 'rpc' | 'extension';

export interface ActivityInputSummary {
  lastSource?: ActivityInputSource;
  lastInputAt?: string;
  counts?: Partial<Record<ActivityInputSource, number>>;
}

export interface ActivityToolWindow {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  endedAt?: string;
  isError?: boolean;
}

export type ActivitySource =
  | 'startup'
  | 'new'
  | 'input'
  | 'message_end'
  | 'turn_start'
  | 'tool_start'
  | 'tool_update'
  | 'tool_end'
  | 'turn_end'
  | 'assistant_error'
  | 'periodic'
  | 'compaction_start'
  | 'compaction_end'
  | 'compaction_abort'
  | 'compaction_expired';

export type SessionCompactionReason = 'manual' | 'threshold' | 'overflow' | null;

export interface SessionActivityCompaction {
  state: 'running';
  startedAt: string;
  updatedAt: string;
  reason: SessionCompactionReason;
  willRetry: boolean;
}

export interface DerivedSessionCompaction {
  state: 'running' | 'stale';
  ageMs: number;
  startedAt: string;
  reason: SessionCompactionReason;
  willRetry: boolean;
}

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
  inputSummary?: ActivityInputSummary;
  recentToolWindows?: ActivityToolWindow[];
  activityUpdatedAt?: string;
  activitySource?: ActivitySource;
  compaction?: SessionActivityCompaction | null;
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
  | 'compaction_malformed'
  | 'compaction_stale'
  | 'compaction_expired'
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
  compactionStaleAfterMs: number;
  compactionExpiredAfterMs: number;
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
  recordInputSource: (source: ActivityInputSource) => Promise<void>;
  recordMessageEnd: (message: ActivityMessageLike) => Promise<void>;
  recordTurnStart: () => Promise<void>;
  recordToolExecutionStart: (event: { toolCallId: string; toolName: string }) => Promise<void>;
  recordToolExecutionUpdate: (event: {
    toolCallId: string;
    toolName: string;
    partialResult?: unknown;
  }) => Promise<void>;
  recordToolExecutionEnd: (event: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
  }) => Promise<void>;
  recordTurnEnd: () => Promise<void>;
  recordCompactionStart: (event: {
    reason?: unknown;
    willRetry?: unknown;
    signal?: AbortSignal;
  }) => Promise<void>;
  clearCompaction: (
    reason: 'completed' | 'aborted' | 'shutdown' | 'session-change' | 'expired',
  ) => Promise<void>;
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
  inputSummary?: ActivityInputSummary;
  recentToolWindows?: ActivityToolWindow[];
  activityUpdatedAt: string | null;
  compaction: DerivedSessionCompaction | null;
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
  compaction: DerivedSessionCompaction | null;
  diagnostics: ActivityDiagnostic[];
}
