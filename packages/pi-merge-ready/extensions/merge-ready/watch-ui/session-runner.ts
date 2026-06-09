import { randomUUID } from 'node:crypto';
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createEventBus,
  getAgentDir,
  type EventBus,
} from '@earendil-works/pi-coding-agent';
import { getErrorMessage } from '../internal.js';
import { assertValidGitHubPullRequestUrl } from '../target.js';
import {
  MERGE_READY_WATCH_STATUS_EVENT,
  createMergeReadyWatchStatusRecord,
  type MergeReadyWatchStatusRecord,
} from '../watch-status.js';
import {
  readMergeReadyPersistedWatchesState,
  reconcilePersistedWatchesState,
  writeMergeReadyPersistedWatchesState,
  type MergeReadyPersistedWatchRecord,
  type MergeReadyPersistedWatchesState,
  type MergeReadyWatchUiPaths,
} from './supervisor-state.js';
import { readMergeReadyTranscript, type MergeReadyTranscriptRow } from './transcript.js';

export type MergeReadyWatchSessionLike = {
  sessionId: string;
  sessionFile: string | undefined;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
};

export type MergeReadyWatchResourceLoaderLike = {
  reload: () => Promise<void>;
};

export type MergeReadyWatchSessionRunnerDependencies = {
  agentDir?: string;
  createEventBus?: typeof createEventBus;
  createResourceLoader?: (options: {
    cwd: string;
    agentDir: string;
    eventBus: EventBus;
    extensionDir: string;
    skillPath: string;
  }) => MergeReadyWatchResourceLoaderLike;
  createSession?: (options: {
    cwd: string;
    agentDir: string;
    resourceLoader: MergeReadyWatchResourceLoaderLike;
    sessionManager: SessionManager;
  }) => Promise<{ session: MergeReadyWatchSessionLike }>;
  createSessionManager?: (cwd: string) => SessionManager;
  now?: () => Date;
  readTranscript?: (sessionFile: string, tail?: number) => Promise<MergeReadyTranscriptRow[]>;
};

export type CreateMergeReadyWatchSessionRunnerOptions = {
  defaultCwd: string;
  extensionDir: string;
  paths: MergeReadyWatchUiPaths;
  skillPath: string;
  dependencies?: MergeReadyWatchSessionRunnerDependencies;
};

export type MergeReadyAddWatchResult = {
  created: boolean;
  message?: string;
  watch: MergeReadyPersistedWatchRecord;
};

export type MergeReadyTranscriptResult = {
  rows: MergeReadyTranscriptRow[];
  watch: MergeReadyPersistedWatchRecord;
};

export type MergeReadyOpenWatchResult = {
  message: string;
  session: {
    sessionId?: string;
    sessionFile?: string;
  };
  supported: false;
  watch: MergeReadyPersistedWatchRecord;
};

type MergeReadyLiveWatchHandle = {
  promptPromise: Promise<void>;
  session: MergeReadyWatchSessionLike;
};

export class MergeReadyWatchSessionRunner {
  private readonly agentDir: string;
  private readonly createResourceLoader: NonNullable<
    MergeReadyWatchSessionRunnerDependencies['createResourceLoader']
  >;
  private readonly createSession: NonNullable<
    MergeReadyWatchSessionRunnerDependencies['createSession']
  >;
  private readonly createSessionManager: NonNullable<
    MergeReadyWatchSessionRunnerDependencies['createSessionManager']
  >;
  private readonly defaultCwd: string;
  private readonly eventBus: EventBus;
  private readonly extensionDir: string;
  private readonly now: NonNullable<MergeReadyWatchSessionRunnerDependencies['now']>;
  private readonly paths: MergeReadyWatchUiPaths;
  private readonly readTranscript: NonNullable<
    MergeReadyWatchSessionRunnerDependencies['readTranscript']
  >;
  private readonly recordsById = new Map<string, MergeReadyPersistedWatchRecord>();
  private readonly skillPath: string;
  private readonly unsubscribeStatus: () => void;
  private readonly liveHandles = new Map<string, MergeReadyLiveWatchHandle>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: CreateMergeReadyWatchSessionRunnerOptions) {
    const dependencies = options.dependencies ?? {};

    this.agentDir = dependencies.agentDir ?? getAgentDir();
    this.createResourceLoader =
      dependencies.createResourceLoader ?? createDefaultMergeReadyWatchResourceLoader;
    this.createSession = dependencies.createSession ?? createDefaultMergeReadyWatchSession;
    this.createSessionManager =
      dependencies.createSessionManager ?? ((cwd: string) => SessionManager.create(cwd));
    this.defaultCwd = options.defaultCwd;
    this.eventBus = (dependencies.createEventBus ?? createEventBus)();
    this.extensionDir = options.extensionDir;
    this.now = dependencies.now ?? (() => new Date());
    this.paths = options.paths;
    this.readTranscript = dependencies.readTranscript ?? readMergeReadyTranscript;
    this.skillPath = options.skillPath;
    this.unsubscribeStatus = this.eventBus.on(MERGE_READY_WATCH_STATUS_EVENT, (data) => {
      this.handleStatusEvent(data);
    });
  }

  static async create(
    options: CreateMergeReadyWatchSessionRunnerOptions,
  ): Promise<MergeReadyWatchSessionRunner> {
    const runner = new MergeReadyWatchSessionRunner(options);
    await runner.initialize();
    return runner;
  }

  getDefaultCwd(): string {
    return this.defaultCwd;
  }

  listWatches(): MergeReadyPersistedWatchRecord[] {
    return this.snapshotState().watches;
  }

  getWatch(id: string): MergeReadyPersistedWatchRecord | null {
    const watch = this.recordsById.get(id);
    return watch ? structuredClone(watch) : null;
  }

  async addWatch(options: { cwd?: string; url: string }): Promise<MergeReadyAddWatchResult> {
    const target = assertValidGitHubPullRequestUrl(options.url.trim());
    const canonicalUrl = target.url;
    const existing = this.findWatchByCanonicalUrl(canonicalUrl);
    if (existing) {
      return {
        created: false,
        message:
          existing.state === 'active'
            ? 'Watch already exists.'
            : 'Watch already exists. Remove it before re-adding in v1.',
        watch: structuredClone(existing),
      };
    }

    const cwd = normalizeWatchCwd(options.cwd, this.defaultCwd);
    const resourceLoader = this.createResourceLoader({
      cwd,
      agentDir: this.agentDir,
      eventBus: this.eventBus,
      extensionDir: this.extensionDir,
      skillPath: this.skillPath,
    });
    await resourceLoader.reload();

    const sessionManager = this.createSessionManager(cwd);
    const { session } = await this.createSession({
      cwd,
      agentDir: this.agentDir,
      resourceLoader,
      sessionManager,
    });

    if (!session.sessionFile) {
      session.dispose();
      throw new Error('Persisted session file unavailable for merge-ready watch UI session.');
    }

    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const record: MergeReadyPersistedWatchRecord = {
      id,
      canonicalUrl,
      cwd,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'active',
      session: {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
      },
      lastStatus: createMergeReadyWatchStatusRecord({
        lifecycle: 'starting',
        requestedUrl: canonicalUrl,
        session: {
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
        },
        summary: `Starting merge-ready watch for ${canonicalUrl}`,
      }),
    };

    this.recordsById.set(id, record);
    await this.persist();

    try {
      const promptPromise = session.prompt(`/merge-ready watch --url ${canonicalUrl}`);
      this.liveHandles.set(id, {
        session,
        promptPromise,
      });
      void Promise.resolve(promptPromise).then(
        () => {
          void this.handlePromptSettled(id);
        },
        (error) => {
          void this.handlePromptSettled(id, error);
        },
      );
    } catch (error) {
      this.recordsById.set(id, {
        ...record,
        state: 'error',
        updatedAt: this.now().toISOString(),
        lastError: getErrorMessage(error),
        lastStatus: createMergeReadyWatchStatusRecord({
          lifecycle: 'error',
          requestedUrl: canonicalUrl,
          session: record.session,
          summary: `Merge-ready watch failed: ${getErrorMessage(error)}`,
        }),
      });
      session.dispose();
      await this.persist();
      throw error;
    }

    return {
      created: true,
      watch: structuredClone(record),
    };
  }

  async stopWatch(id: string): Promise<MergeReadyPersistedWatchRecord | null> {
    const record = this.recordsById.get(id);
    if (!record) {
      return null;
    }

    const liveHandle = this.liveHandles.get(id);
    if (!liveHandle) {
      if (record.state === 'active') {
        record.state = 'stale';
        record.updatedAt = this.now().toISOString();
        await this.persist();
      }
      return structuredClone(record);
    }

    record.state = 'stopped';
    record.updatedAt = this.now().toISOString();
    record.lastStatus = transitionMergeReadyWatchStatusRecord(
      record.lastStatus,
      'stopped',
      `Merge-ready watch stopped for ${record.canonicalUrl}`,
      record.canonicalUrl,
      record.session,
      this.now(),
    );
    await this.persist();

    this.liveHandles.delete(id);

    try {
      await liveHandle.session.abort();
    } catch (error) {
      record.lastError = getErrorMessage(error);
    }

    try {
      liveHandle.session.dispose();
    } catch {
      // Best-effort cleanup only.
    }

    await Promise.resolve(liveHandle.promptPromise).catch(() => undefined);
    await this.persist();
    return structuredClone(record);
  }

  async removeWatch(id: string): Promise<boolean> {
    if (this.liveHandles.has(id)) {
      return false;
    }

    const deleted = this.recordsById.delete(id);
    if (!deleted) {
      return false;
    }

    await this.persist();
    return true;
  }

  async readTranscriptForWatch(id: string, tail = 200): Promise<MergeReadyTranscriptResult | null> {
    const watch = this.recordsById.get(id);
    if (!watch) {
      return null;
    }

    const sessionFile = watch.session.sessionFile;
    if (!sessionFile) {
      return {
        rows: [],
        watch: structuredClone(watch),
      };
    }

    return {
      rows: await this.readTranscript(sessionFile, tail),
      watch: structuredClone(watch),
    };
  }

  async openWatch(id: string): Promise<MergeReadyOpenWatchResult | null> {
    const watch = this.recordsById.get(id);
    if (!watch) {
      return null;
    }

    return {
      supported: false,
      message:
        'Live focus/open is not supported in watch-ui v1. Use the session file path instead.',
      session: {
        ...watch.session,
      },
      watch: structuredClone(watch),
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribeStatus();

    for (const id of [...this.liveHandles.keys()]) {
      await this.stopWatch(id);
    }
  }

  private async initialize(): Promise<void> {
    const persistedState = await readMergeReadyPersistedWatchesState(this.paths);
    const reconciledState = reconcilePersistedWatchesState(persistedState);

    this.recordsById.clear();
    for (const watch of reconciledState.watches) {
      this.recordsById.set(watch.id, structuredClone(watch));
    }

    await this.persist();
  }

  private handleStatusEvent(data: unknown): void {
    if (!isMergeReadyWatchStatusRecord(data)) {
      return;
    }

    const watch = this.findWatchForStatus(data);
    if (!watch || watch.state === 'stale') {
      return;
    }

    watch.lastStatus = structuredClone(data);
    watch.updatedAt = this.now().toISOString();
    if (data.lifecycle === 'error') {
      watch.state = 'error';
      watch.lastError = data.summary;
    } else if (data.lifecycle === 'stopped') {
      watch.state = 'stopped';
    } else {
      watch.state = 'active';
    }

    void this.persist().catch(() => {
      // Best-effort event persistence only.
    });
  }

  private async handlePromptSettled(id: string, error?: unknown): Promise<void> {
    const liveHandle = this.liveHandles.get(id);
    if (liveHandle) {
      this.liveHandles.delete(id);
      try {
        liveHandle.session.dispose();
      } catch {
        // Best-effort cleanup only.
      }
    }

    const watch = this.recordsById.get(id);
    if (!watch) {
      return;
    }

    if (error !== undefined) {
      if (watch.state === 'stopped' && isAbortLikeError(error)) {
        await this.persist();
        return;
      }

      watch.state = 'error';
      watch.updatedAt = this.now().toISOString();
      watch.lastError = getErrorMessage(error);
      watch.lastStatus = transitionMergeReadyWatchStatusRecord(
        watch.lastStatus,
        'error',
        `Merge-ready watch failed: ${getErrorMessage(error)}`,
        watch.canonicalUrl,
        watch.session,
        this.now(),
      );
      await this.persist();
      return;
    }

    if (watch.state === 'active') {
      watch.state = watch.lastStatus?.lifecycle === 'error' ? 'error' : 'stopped';
      watch.updatedAt = this.now().toISOString();
      if (watch.lastStatus?.lifecycle !== 'stopped' && watch.lastStatus?.lifecycle !== 'error') {
        watch.lastStatus = transitionMergeReadyWatchStatusRecord(
          watch.lastStatus,
          'stopped',
          `Merge-ready watch stopped for ${watch.canonicalUrl}`,
          watch.canonicalUrl,
          watch.session,
          this.now(),
        );
      }
      await this.persist();
    }
  }

  private findWatchByCanonicalUrl(
    canonicalUrl: string,
  ): MergeReadyPersistedWatchRecord | undefined {
    return [...this.recordsById.values()].find((watch) => watch.canonicalUrl === canonicalUrl);
  }

  private findWatchForStatus(
    status: MergeReadyWatchStatusRecord,
  ): MergeReadyPersistedWatchRecord | undefined {
    const sessionId = status.session.sessionId;
    if (sessionId) {
      const match = [...this.recordsById.values()].find(
        (watch) => watch.session.sessionId === sessionId,
      );
      if (match) {
        return match;
      }
    }

    const sessionFile = status.session.sessionFile;
    if (sessionFile) {
      const match = [...this.recordsById.values()].find(
        (watch) => watch.session.sessionFile === sessionFile,
      );
      if (match) {
        return match;
      }
    }

    const canonicalUrl = status.target.canonicalUrl ?? status.target.requestedUrl;
    if (!canonicalUrl) {
      return undefined;
    }

    return this.findWatchByCanonicalUrl(canonicalUrl);
  }

  private snapshotState(): MergeReadyPersistedWatchesState {
    return {
      version: 1,
      watches: [...this.recordsById.values()].map((watch) => structuredClone(watch)),
    };
  }

  private async persist(): Promise<void> {
    const snapshot = this.snapshotState();
    this.writeQueue = this.writeQueue.then(() =>
      writeMergeReadyPersistedWatchesState(this.paths, snapshot),
    );
    await this.writeQueue;
  }
}

export async function createMergeReadyWatchSessionRunner(
  options: CreateMergeReadyWatchSessionRunnerOptions,
): Promise<MergeReadyWatchSessionRunner> {
  return MergeReadyWatchSessionRunner.create(options);
}

function createDefaultMergeReadyWatchResourceLoader(options: {
  cwd: string;
  agentDir: string;
  eventBus: EventBus;
  extensionDir: string;
  skillPath: string;
}): MergeReadyWatchResourceLoaderLike {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    eventBus: options.eventBus,
    additionalExtensionPaths: [options.extensionDir],
    additionalSkillPaths: [options.skillPath],
  });
}

async function createDefaultMergeReadyWatchSession(options: {
  cwd: string;
  agentDir: string;
  resourceLoader: MergeReadyWatchResourceLoaderLike;
  sessionManager: SessionManager;
}): Promise<{ session: MergeReadyWatchSessionLike }> {
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    resourceLoader: options.resourceLoader as never,
    sessionManager: options.sessionManager,
  });
  return { session };
}

function transitionMergeReadyWatchStatusRecord(
  current: MergeReadyWatchStatusRecord | undefined,
  lifecycle: 'error' | 'stopped',
  summary: string,
  requestedUrl: string,
  session: {
    sessionId?: string;
    sessionFile?: string;
  },
  now: Date,
): MergeReadyWatchStatusRecord {
  if (!current) {
    return createMergeReadyWatchStatusRecord({
      lifecycle,
      requestedUrl,
      session,
      summary,
      updatedAt: now,
    });
  }

  return {
    ...current,
    lifecycle,
    summary,
    updatedAt: now.toISOString(),
    session: {
      ...current.session,
      ...session,
    },
    target: {
      ...current.target,
      ...(current.target.requestedUrl === undefined ? { requestedUrl } : {}),
      ...(current.target.canonicalUrl === undefined ? { canonicalUrl: requestedUrl } : {}),
    },
  };
}

function isMergeReadyWatchStatusRecord(value: unknown): value is MergeReadyWatchStatusRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    'lifecycle' in value &&
    'summary' in value &&
    'target' in value &&
    'session' in value
  );
}

function isAbortLikeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ((error as { name?: unknown }).name === 'AbortError' ||
      (error as { name?: unknown }).name === 'CanceledError')
  );
}

function normalizeWatchCwd(cwd: string | undefined, fallbackCwd: string): string {
  const trimmed = cwd?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallbackCwd;
}
