import { parseGitHubPullRequestUrl } from './target.js';
import type { MergeReadyState, MergeReadyStatus, PullRequestLifecycle } from './types.js';

export const MERGE_READY_WATCH_STATUS_SCHEMA_VERSION = 1 as const;
export const MERGE_READY_WATCH_STATUS_CUSTOM_TYPE = 'merge-ready-watch-status';
export const MERGE_READY_WATCH_STATUS_EVENT = 'merge-ready-watch:status';

export type MergeReadyWatchLifecycleState =
  | 'starting'
  | 'watching'
  | 'repairing'
  | 'stopped'
  | 'error';

export type MergeReadyWatchSessionRef = {
  sessionId?: string;
  sessionFile?: string;
};

export type MergeReadyWatchTargetInfo = {
  mode: 'current_branch' | 'url';
  requestedUrl?: string;
  canonicalUrl?: string;
  repository?: string;
  pullRequestNumber?: number;
  pullRequestKey?: string;
  branch?: string;
};

export type MergeReadyWatchStatusRecord = {
  schemaVersion: typeof MERGE_READY_WATCH_STATUS_SCHEMA_VERSION;
  lifecycle: MergeReadyWatchLifecycleState;
  mergeReadyState: MergeReadyState;
  summary: string;
  updatedAt: string;
  generatedAt?: string;
  target: MergeReadyWatchTargetInfo;
  session: MergeReadyWatchSessionRef;
  pr?: {
    lifecycle: PullRequestLifecycle;
    number: number;
    url: string;
    title?: string;
    headRefName: string;
    baseRefName: string;
  };
};

export type MergeReadyWatchStatusPublisher = {
  appendEntry?: (customType: string, data?: unknown) => void;
  events?: {
    emit: (channel: string, data: unknown) => void;
  };
};

export type CreateMergeReadyWatchStatusRecordOptions = {
  lifecycle: MergeReadyWatchLifecycleState;
  requestedUrl?: string | undefined;
  session?: MergeReadyWatchSessionRef | undefined;
  status?:
    | Pick<MergeReadyStatus, 'generatedAt' | 'pr' | 'state' | 'summary' | 'target'>
    | undefined;
  summary?: string | undefined;
  updatedAt?: string | Date | undefined;
};

export type PublishMergeReadyWatchStatusOptions = CreateMergeReadyWatchStatusRecordOptions & {
  publisher?: MergeReadyWatchStatusPublisher;
};

export function publishMergeReadyWatchStatus(
  options: PublishMergeReadyWatchStatusOptions,
): MergeReadyWatchStatusRecord {
  const record = createMergeReadyWatchStatusRecord(options);
  options.publisher?.appendEntry?.(MERGE_READY_WATCH_STATUS_CUSTOM_TYPE, record);
  options.publisher?.events?.emit(MERGE_READY_WATCH_STATUS_EVENT, record);
  return record;
}

export function createMergeReadyWatchStatusRecord(
  options: CreateMergeReadyWatchStatusRecordOptions,
): MergeReadyWatchStatusRecord {
  const updatedAt = normalizeTimestamp(options.updatedAt);
  const target = createMergeReadyWatchTargetInfo(options.status, options.requestedUrl);
  const summary =
    options.summary ?? options.status?.summary ?? defaultLifecycleSummary(options.lifecycle);

  return {
    schemaVersion: MERGE_READY_WATCH_STATUS_SCHEMA_VERSION,
    lifecycle: options.lifecycle,
    mergeReadyState: options.status?.state ?? 'unknown',
    summary,
    updatedAt,
    ...(options.status?.generatedAt === undefined
      ? {}
      : { generatedAt: normalizeTimestamp(options.status.generatedAt) }),
    target,
    session: { ...(options.session ?? {}) },
    ...(options.status?.pr === null || options.status?.pr === undefined
      ? {}
      : {
          pr: {
            lifecycle: options.status.pr.lifecycle,
            number: options.status.pr.number,
            url: options.status.pr.url,
            ...(options.status.pr.title.length === 0 ? {} : { title: options.status.pr.title }),
            headRefName: options.status.pr.headRefName,
            baseRefName: options.status.pr.baseRefName,
          },
        }),
  };
}

function createMergeReadyWatchTargetInfo(
  status: Pick<MergeReadyStatus, 'pr' | 'target'> | undefined,
  requestedUrl: string | undefined,
): MergeReadyWatchTargetInfo {
  const parsedRequestedUrl =
    requestedUrl === undefined ? null : parseGitHubPullRequestUrl(requestedUrl.trim());
  const parsedPrUrl = status?.pr ? parseGitHubPullRequestUrl(status.pr.url) : null;
  const repositoryOwner =
    status?.target.mode === 'url'
      ? status.target.owner
      : (parsedPrUrl?.owner ?? parsedRequestedUrl?.owner);
  const repositoryName =
    status?.target.mode === 'url'
      ? status.target.repo
      : (parsedPrUrl?.repo ?? parsedRequestedUrl?.repo);
  const pullRequestNumber =
    status?.pr?.number ??
    (status?.target.mode === 'url' ? status.target.prNumber : undefined) ??
    parsedRequestedUrl?.prNumber;
  const repository =
    repositoryOwner === undefined || repositoryName === undefined
      ? undefined
      : `${repositoryOwner}/${repositoryName}`;

  return {
    mode: status?.target.mode ?? (parsedRequestedUrl ? 'url' : 'current_branch'),
    ...(parsedRequestedUrl === null ? {} : { requestedUrl: parsedRequestedUrl.url }),
    ...(status?.pr?.url
      ? { canonicalUrl: status.pr.url }
      : status?.target.mode === 'url'
        ? { canonicalUrl: status.target.url }
        : parsedRequestedUrl === null
          ? {}
          : { canonicalUrl: parsedRequestedUrl.url }),
    ...(repository === undefined ? {} : { repository }),
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(repository === undefined || pullRequestNumber === undefined
      ? {}
      : { pullRequestKey: `${repository}#${String(pullRequestNumber)}` }),
    ...(status?.target.mode === 'current_branch' && status.target.branch !== undefined
      ? { branch: status.target.branch }
      : {}),
  };
}

function defaultLifecycleSummary(lifecycle: MergeReadyWatchLifecycleState): string {
  if (lifecycle === 'starting') {
    return 'Starting merge-ready watch';
  }

  if (lifecycle === 'repairing') {
    return 'Repairing merge-ready blockers';
  }

  if (lifecycle === 'stopped') {
    return 'Merge-ready watch stopped';
  }

  if (lifecycle === 'error') {
    return 'Merge-ready watch failed';
  }

  return 'Watching merge readiness';
}

function normalizeTimestamp(value: string | Date | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}
