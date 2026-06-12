import { inspectPresencePid } from './pid.js';
import { resolvePresenceThresholds } from './constants.js';
import type {
  InspectPresencePid,
  PresenceRecord,
  PresenceState,
  PresenceStateReason,
  PresenceSummary,
  PresenceThresholds,
} from './types.js';

export interface ClassifyPresenceRecordOptions {
  now?: Date;
  thresholds?: Partial<PresenceThresholds>;
  inspectPid?: InspectPresencePid;
}

export async function classifyPresenceRecord(
  record: PresenceRecord,
  options: ClassifyPresenceRecordOptions = {},
): Promise<PresenceSummary> {
  const now = options.now ?? new Date();
  const thresholds = resolvePresenceThresholds(options.thresholds);
  const nowMs = now.getTime();
  const startedAtMs = Date.parse(record.startedAt);
  const heartbeatAtMs = Date.parse(record.heartbeatAt);

  if (!Number.isFinite(startedAtMs) || !Number.isFinite(heartbeatAtMs)) {
    return createPresenceSummary(record, 'unknown', Number.NaN, 'invalid_timestamp');
  }

  if (startedAtMs > nowMs || heartbeatAtMs > nowMs) {
    return createPresenceSummary(record, 'unknown', nowMs - heartbeatAtMs, 'future_timestamp');
  }

  const heartbeatAgeMs = Math.max(0, nowMs - heartbeatAtMs);
  if (heartbeatAgeMs > thresholds.deadAfterMs) {
    return createPresenceSummary(record, 'dead', heartbeatAgeMs, 'heartbeat_expired');
  }

  const inspectPid = options.inspectPid ?? inspectPresencePid;
  const pidValidation = await inspectPidSafely(record, inspectPid);

  if (pidValidation.status === 'missing') {
    return createPresenceSummary(record, 'dead', heartbeatAgeMs, 'pid_missing');
  }

  if (pidValidation.status === 'reused') {
    return createPresenceSummary(record, 'dead', heartbeatAgeMs, 'pid_reused');
  }

  if (heartbeatAgeMs <= thresholds.liveAfterMs && pidValidation.status === 'matches') {
    return createPresenceSummary(record, 'live', heartbeatAgeMs, 'fresh_heartbeat');
  }

  if (heartbeatAgeMs <= thresholds.liveAfterMs) {
    return createPresenceSummary(
      record,
      'stale',
      heartbeatAgeMs,
      pidValidation.reason ?? 'pid_unverified',
    );
  }

  return createPresenceSummary(record, 'stale', heartbeatAgeMs, 'heartbeat_expired');
}

async function inspectPidSafely(
  record: PresenceRecord,
  inspectPid: InspectPresencePid,
): ReturnType<InspectPresencePid> {
  try {
    return await inspectPid(record);
  } catch {
    return { status: 'unverified', reason: 'pid_unverified' };
  }
}

function createPresenceSummary(
  record: PresenceRecord,
  presenceState: PresenceState,
  heartbeatAgeMs: number,
  reason?: PresenceStateReason,
): PresenceSummary {
  return {
    runtimeId: record.runtimeId,
    pid: record.pid,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
    heartbeatAgeMs,
    presenceState,
    ...(reason === undefined ? {} : { reason }),
  };
}
