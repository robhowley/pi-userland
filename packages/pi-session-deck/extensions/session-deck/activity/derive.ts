import { MAX_ACTIVITY_ERROR_LENGTH, resolveActivityThresholds } from './constants.js';
import type {
  ActivityDiagnostic,
  ActivityThresholds,
  DerivedActivity,
  SessionActivityRecord,
} from './types.js';

export interface DeriveActivityOptions {
  activity: SessionActivityRecord | null;
  sessionId: string | null;
  now?: Date;
  thresholds?: Partial<ActivityThresholds>;
  baseDiagnostics?: ActivityDiagnostic[];
}

export function deriveActivity(options: DeriveActivityOptions): DerivedActivity {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const thresholds = resolveActivityThresholds(options.thresholds);
  const diagnostics = [...(options.baseDiagnostics ?? [])];

  if (options.activity === null) {
    if (!hasBlockingActivityDiagnostic(diagnostics)) {
      diagnostics.push({
        code: 'activity_missing',
        message: 'No activity record for this runtime',
      });
    }

    return createUnknownActivity(diagnostics);
  }

  const activity = options.activity;
  const trustedFields = getTrustedFields(activity);

  if (activity.sessionId !== options.sessionId) {
    diagnostics.push({
      code: 'session_mismatch',
      message: 'Ignored activity record from a different sessionId',
      runtimeId: activity.runtimeId,
    });
    return createUnknownActivity(diagnostics);
  }

  const snapshotTimestamp = activity.activityUpdatedAt ?? activity.lastEventAt;
  const snapshotMs = parseTimestamp(snapshotTimestamp);
  if (snapshotMs === null) {
    diagnostics.push({
      code: 'last_event_missing',
      message: 'Activity record is missing a usable activityUpdatedAt/lastEventAt timestamp',
      runtimeId: activity.runtimeId,
    });
    return { ...createUnknownActivity(diagnostics), ...trustedFields };
  }

  if (snapshotMs - nowMs > thresholds.futureSkewMs) {
    diagnostics.push({
      code: 'last_event_future',
      message: 'Activity record timestamp is in the future',
      runtimeId: activity.runtimeId,
    });
    return { ...createUnknownActivity(diagnostics), ...trustedFields };
  }

  if (hasBusyIdleConflict(activity)) {
    diagnostics.push({
      code: 'busy_idle_conflict',
      message: 'Activity record has conflicting busy/idle flags',
      runtimeId: activity.runtimeId,
    });
    return { ...createUnknownActivity(diagnostics), ...trustedFields };
  }

  if (activity.busy && activity.currentTurnStartedAt === null) {
    diagnostics.push({
      code: 'turn_started_missing',
      message: 'Busy activity record is missing currentTurnStartedAt',
      runtimeId: activity.runtimeId,
    });
    return { ...createUnknownActivity(diagnostics), ...trustedFields };
  }

  if (activity.activityState === 'tool-running' && activity.currentToolName === null) {
    diagnostics.push({
      code: 'tool_name_missing',
      message: 'tool-running activity record is missing currentToolName',
      runtimeId: activity.runtimeId,
    });
    return { ...createUnknownActivity(diagnostics), ...trustedFields };
  }

  const snapshotAgeMs = Math.max(0, nowMs - snapshotMs);
  if (snapshotAgeMs > thresholds.veryStaleAfterMs || snapshotAgeMs > thresholds.staleAfterMs) {
    diagnostics.push({
      code: 'activity_stale',
      message: 'Activity record is stale',
      runtimeId: activity.runtimeId,
    });
    return { ...createUnknownActivity(diagnostics), ...trustedFields };
  }

  if (activity.busy) {
    const eventMs = parseTimestamp(activity.lastEventAt);
    if (eventMs === null) {
      diagnostics.push({
        code: 'last_event_missing',
        message: 'Busy activity record is missing lastEventAt',
        runtimeId: activity.runtimeId,
      });
      return { ...createUnknownActivity(diagnostics), ...trustedFields };
    }

    const eventAgeMs = Math.max(0, nowMs - eventMs);
    if (eventAgeMs > thresholds.toolStuckAfterMs) {
      diagnostics.push({
        code: activity.currentToolName === null ? 'activity_stale' : 'tool_stuck',
        message:
          activity.currentToolName === null
            ? 'Busy activity record is stale'
            : `Tool ${activity.currentToolName} appears stuck`,
        runtimeId: activity.runtimeId,
      });
      return { ...createUnknownActivity(diagnostics), ...trustedFields };
    }
  }

  if (activity.activityState === 'error') {
    diagnostics.push({
      code: 'last_error_active',
      message: 'Assistant error is the active activity state',
      runtimeId: activity.runtimeId,
    });
    return {
      ...trustedFields,
      activityState: 'error',
      activityAgeMs: null,
      diagnostics,
    };
  }

  if (activity.busy && activity.currentToolName !== null) {
    return {
      ...trustedFields,
      activityState: 'tool-running',
      activityAgeMs: computeAgeMs(
        nowMs,
        activity.lastToolStartedAt ?? activity.lastEventAt ?? activity.currentTurnStartedAt,
      ),
      diagnostics,
    };
  }

  if (activity.busy) {
    return {
      ...trustedFields,
      activityState: 'thinking',
      activityAgeMs: computeAgeMs(nowMs, activity.currentTurnStartedAt),
      diagnostics,
    };
  }

  if (activity.idle && !activity.busy) {
    return {
      ...trustedFields,
      activityState: 'waiting',
      activityAgeMs: null,
      diagnostics,
    };
  }

  return { ...createUnknownActivity(diagnostics), ...trustedFields };
}

export function sanitizeActivityError(
  message: string | null | undefined,
  fallback: string,
  maxLength = MAX_ACTIVITY_ERROR_LENGTH,
): string {
  const compact = (message ?? '').replace(/\s+/g, ' ').trim();
  const sanitized = compact.length > 0 ? compact : fallback;

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function createToolFailureError(toolName: string): string {
  return sanitizeActivityError(null, `tool ${toolName} failed`);
}

function getTrustedFields(
  activity: SessionActivityRecord,
): Omit<DerivedActivity, 'activityState' | 'activityAgeMs' | 'diagnostics'> {
  return {
    idle: activity.idle,
    busy: activity.busy,
    currentTurnStartedAt: activity.currentTurnStartedAt,
    currentToolName: activity.currentToolName,
    lastEventAt: activity.lastEventAt,
    lastError: activity.lastError,
    activityUpdatedAt: activity.activityUpdatedAt ?? activity.lastEventAt,
  };
}

function createUnknownActivity(diagnostics: ActivityDiagnostic[]): DerivedActivity {
  return {
    activityState: 'unknown',
    activityAgeMs: null,
    idle: null,
    busy: null,
    currentTurnStartedAt: null,
    currentToolName: null,
    lastEventAt: null,
    lastError: null,
    activityUpdatedAt: null,
    diagnostics,
  };
}

function hasBlockingActivityDiagnostic(diagnostics: ActivityDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    ['activity_read_error', 'activity_write_error', 'malformed_activity_record'].includes(
      diagnostic.code,
    ),
  );
}

function hasBusyIdleConflict(activity: SessionActivityRecord): boolean {
  if (activity.busy && activity.idle) {
    return true;
  }

  if (!activity.busy && !activity.idle) {
    return activity.activityState !== 'error' && activity.activityState !== 'unknown';
  }

  return false;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeAgeMs(nowMs: number, value: string | null | undefined): number | null {
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return null;
  }

  return Math.max(0, nowMs - parsed);
}
