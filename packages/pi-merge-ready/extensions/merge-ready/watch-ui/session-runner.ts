import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
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
  createMergeReadyWatchUiSnapshotModel,
  assertMergeReadyWatchUiRuntimeSnapshot,
  getMergeReadyWatchUiRuntimePaths,
  isMergeReadyWatchUiRuntimePreflightError,
  MergeReadyWatchUiRuntimePreflightError,
  type MergeReadyWatchUiRuntimeSnapshot,
} from './runtime-snapshot.js';
import {
  getMergeReadyWatchUiPaths,
  readMergeReadyPersistedWatchesState,
  reconcilePersistedWatchesState,
  writeMergeReadyPersistedWatchesState,
  type MergeReadyPersistedWatchRecord,
  type MergeReadyPersistedWatchesState,
  type MergeReadyWatchUiPaths,
} from './supervisor-state.js';
import { readMergeReadyTranscript, type MergeReadyTranscriptRow } from './transcript.js';

type MergeReadyWatchRegisteredCommandLike = {
  name: string;
  invocationName: string;
  handler: (...args: any[]) => Promise<void>;
};

type MergeReadyWatchExtensionRunnerLike = {
  createCommandContext: () => any;
  getRegisteredCommands: () => MergeReadyWatchRegisteredCommandLike[];
};

export type MergeReadyWatchSessionLike = {
  sessionId: string;
  sessionFile: string | undefined;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  extensionRunner?: MergeReadyWatchExtensionRunnerLike;
};

export type MergeReadyWatchResourceLoaderLike = {
  reload: () => Promise<void>;
};

type MergeReadyWatchSessionRuntimeConfig = {
  authStorage: AuthStorage;
  model: MergeReadyWatchUiRuntimeSnapshot['model'];
  modelRegistry: ModelRegistry;
  thinkingLevel: MergeReadyWatchUiRuntimeSnapshot['thinkingLevel'];
};

export type MergeReadyWatchSessionRunnerDependencies = {
  agentDir?: string;
  createAuthStorage?: (authStoragePath: string) => AuthStorage;
  createEventBus?: typeof createEventBus;
  createModelRegistry?: (authStorage: AuthStorage, modelRegistryPath: string) => ModelRegistry;
  createResourceLoader?: (options: {
    cwd: string;
    agentDir: string;
    eventBus: EventBus;
    extensionDir: string;
    skillPath: string;
  }) => MergeReadyWatchResourceLoaderLike;
  createSession?: (options: {
    authStorage?: AuthStorage;
    cwd: string;
    agentDir: string;
    model?: MergeReadyWatchUiRuntimeSnapshot['model'];
    modelRegistry?: ModelRegistry;
    resourceLoader: MergeReadyWatchResourceLoaderLike;
    sessionManager: SessionManager;
    thinkingLevel?: MergeReadyWatchUiRuntimeSnapshot['thinkingLevel'];
  }) => Promise<{ session: MergeReadyWatchSessionLike }>;
  createSessionManager?: (cwd: string) => SessionManager;
  now?: () => Date;
  readTranscript?: (sessionFile: string, tail?: number) => Promise<MergeReadyTranscriptRow[]>;
};

export type CreateMergeReadyWatchSessionRunnerOptions = {
  defaultCwd: string;
  extensionDir: string;
  paths: MergeReadyWatchUiPaths;
  runtimeSnapshot?: MergeReadyWatchUiRuntimeSnapshot;
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

export class MergeReadyWatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeReadyWatchInputError';
  }
}

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
  private readonly createAuthStorage: NonNullable<
    MergeReadyWatchSessionRunnerDependencies['createAuthStorage']
  >;
  private readonly createModelRegistry: NonNullable<
    MergeReadyWatchSessionRunnerDependencies['createModelRegistry']
  >;
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
  private readonly runtimeSnapshot: MergeReadyWatchUiRuntimeSnapshot | undefined;
  private readonly skillPath: string;
  private readonly unsubscribeStatus: () => void;
  private readonly liveHandles = new Map<string, MergeReadyLiveWatchHandle>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: CreateMergeReadyWatchSessionRunnerOptions) {
    const dependencies = options.dependencies ?? {};

    this.runtimeSnapshot = options.runtimeSnapshot;
    this.agentDir = path.resolve(
      options.runtimeSnapshot?.agentDir ?? dependencies.agentDir ?? getAgentDir(),
    );
    this.createAuthStorage = dependencies.createAuthStorage ?? AuthStorage.create;
    this.createModelRegistry = dependencies.createModelRegistry ?? ModelRegistry.create;
    this.createResourceLoader =
      dependencies.createResourceLoader ?? createDefaultMergeReadyWatchResourceLoader;
    this.createSession = dependencies.createSession ?? createDefaultMergeReadyWatchSession;
    this.createSessionManager =
      dependencies.createSessionManager ?? ((cwd: string) => SessionManager.create(cwd));
    this.defaultCwd = options.runtimeSnapshot?.defaultCwd ?? options.defaultCwd;
    this.eventBus = (dependencies.createEventBus ?? createEventBus)();
    this.extensionDir = options.extensionDir;
    this.now = dependencies.now ?? (() => new Date());
    this.paths = options.paths;
    this.readTranscript = dependencies.readTranscript ?? readMergeReadyTranscript;
    this.skillPath = options.skillPath;
    if (this.runtimeSnapshot) {
      assertMergeReadyWatchUiPathsMatchAgentDir(this.paths, this.agentDir);
    }
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
    let target: ReturnType<typeof assertValidGitHubPullRequestUrl>;
    try {
      target = assertValidGitHubPullRequestUrl(options.url.trim());
    } catch (error) {
      throw new MergeReadyWatchInputError(getErrorMessage(error));
    }

    const canonicalUrl = target.url;
    const cwd = await normalizeWatchCwd(options.cwd, this.defaultCwd);
    const existing = this.findWatchByCanonicalUrl(canonicalUrl);
    if (existing) {
      return {
        created: false,
        message: formatDuplicateWatchMessage(existing, cwd),
        watch: structuredClone(existing),
      };
    }

    const resourceLoader = this.createResourceLoader({
      cwd,
      agentDir: this.agentDir,
      eventBus: this.eventBus,
      extensionDir: this.extensionDir,
      skillPath: this.skillPath,
    });
    await resourceLoader.reload();

    const sessionManager = this.createSessionManager(cwd);
    const sessionRuntime = this.createWatchSessionRuntime();
    let session: MergeReadyWatchSessionLike;
    try {
      ({ session } = await this.createSession({
        ...(sessionRuntime ?? {}),
        cwd,
        agentDir: this.agentDir,
        resourceLoader,
        sessionManager,
      }));
    } catch (error) {
      if (isMergeReadyWatchUiRuntimePreflightError(error)) {
        throw error;
      }
      if (this.runtimeSnapshot) {
        throw new MergeReadyWatchUiRuntimePreflightError(
          `unable to create a child session from the captured runtime: ${getErrorMessage(error)}`,
        );
      }
      throw error;
    }

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
      const promptPromise = startMergeReadyWatchInSession(session, canonicalUrl);
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

  private createWatchSessionRuntime(): MergeReadyWatchSessionRuntimeConfig | undefined {
    const snapshot = this.runtimeSnapshot;
    if (!snapshot) {
      return undefined;
    }

    assertMergeReadyWatchUiRuntimeSnapshot(snapshot);
    const runtimePaths = getMergeReadyWatchUiRuntimePaths(this.agentDir);

    let authStorage: AuthStorage;
    try {
      authStorage = this.createAuthStorage(runtimePaths.authStoragePath);
    } catch (error) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `failed to load auth storage from ${runtimePaths.authStoragePath}: ${getErrorMessage(error)}`,
      );
    }

    const authStorageErrors = authStorage.drainErrors();
    if (authStorageErrors.length > 0) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `failed to load auth storage from ${runtimePaths.authStoragePath}: ${authStorageErrors.map((error) => error.message).join('; ')}`,
      );
    }

    if (snapshot.auth.apiKey) {
      authStorage.setRuntimeApiKey(snapshot.auth.provider, snapshot.auth.apiKey);
    }

    let modelRegistry: ModelRegistry;
    try {
      modelRegistry = this.createModelRegistry(authStorage, runtimePaths.modelRegistryPath);
    } catch (error) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `failed to load model registry from ${runtimePaths.modelRegistryPath}: ${getErrorMessage(error)}`,
      );
    }

    const modelRegistryError = modelRegistry.getError();
    if (modelRegistryError) {
      throw new MergeReadyWatchUiRuntimePreflightError(
        `failed to load model registry from ${runtimePaths.modelRegistryPath}: ${modelRegistryError}`,
      );
    }

    return {
      authStorage,
      model: createMergeReadyWatchUiSnapshotModel(snapshot),
      modelRegistry,
      thinkingLevel: snapshot.thinkingLevel,
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

async function startMergeReadyWatchInSession(
  session: MergeReadyWatchSessionLike,
  canonicalUrl: string,
): Promise<void> {
  const command = resolveMergeReadyWatchCommand(session);
  if (command) {
    await command.handler(
      `watch --url ${canonicalUrl}`,
      session.extensionRunner?.createCommandContext(),
    );
    return;
  }

  await session.prompt(`/merge-ready watch --url ${canonicalUrl}`);
}

function resolveMergeReadyWatchCommand(
  session: MergeReadyWatchSessionLike,
): MergeReadyWatchRegisteredCommandLike | undefined {
  const commands = session.extensionRunner?.getRegisteredCommands();
  if (!commands || commands.length === 0) {
    return undefined;
  }

  const mergeReadyCommands = commands.filter((command) => command.name === 'merge-ready');
  if (mergeReadyCommands.length === 0) {
    return undefined;
  }

  return (
    mergeReadyCommands.find((command) => command.invocationName === 'merge-ready') ??
    mergeReadyCommands[0]
  );
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
  authStorage?: AuthStorage;
  cwd: string;
  agentDir: string;
  model?: MergeReadyWatchUiRuntimeSnapshot['model'];
  modelRegistry?: ModelRegistry;
  resourceLoader: MergeReadyWatchResourceLoaderLike;
  sessionManager: SessionManager;
  thinkingLevel?: MergeReadyWatchUiRuntimeSnapshot['thinkingLevel'];
}): Promise<{ session: MergeReadyWatchSessionLike }> {
  const { session } = await createAgentSession({
    ...(options.authStorage === undefined ? {} : { authStorage: options.authStorage }),
    cwd: options.cwd,
    agentDir: options.agentDir,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.modelRegistry === undefined ? {} : { modelRegistry: options.modelRegistry }),
    resourceLoader: options.resourceLoader as never,
    sessionManager: options.sessionManager,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
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

async function normalizeWatchCwd(
  cwd: string | undefined,
  fallbackCwd: string,
): Promise<string> {
  const resolvedFallbackCwd = path.resolve(fallbackCwd);
  const trimmed = cwd?.trim();
  const candidate = trimmed && trimmed.length > 0 ? trimmed : resolvedFallbackCwd;
  const resolvedCwd = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(resolvedFallbackCwd, candidate);

  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(resolvedCwd);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      throw new MergeReadyWatchInputError(`cwd does not exist: ${JSON.stringify(resolvedCwd)}`);
    }
    throw error;
  }

  const cwdStat = await stat(canonicalCwd);
  if (!cwdStat.isDirectory()) {
    throw new MergeReadyWatchInputError(`cwd is not a directory: ${JSON.stringify(canonicalCwd)}`);
  }

  return canonicalCwd;
}

function formatDuplicateWatchMessage(
  existing: MergeReadyPersistedWatchRecord,
  requestedCwd: string,
): string {
  if (existing.cwd !== requestedCwd) {
    return `Watch already exists for this PR. Current cwd: ${JSON.stringify(existing.cwd)}. Requested cwd: ${JSON.stringify(requestedCwd)}. Remove the existing watch and recreate it to use the requested cwd in v1.`;
  }

  return existing.state === 'active'
    ? 'Watch already exists.'
    : 'Watch already exists. Remove it before re-adding in v1.';
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertMergeReadyWatchUiPathsMatchAgentDir(
  paths: MergeReadyWatchUiPaths,
  agentDir: string,
): void {
  const expectedPaths = getMergeReadyWatchUiPaths(agentDir);
  const pathEntries: Array<[string, string, string]> = [
    ['stateDir', paths.stateDir, expectedPaths.stateDir],
    ['supervisorInfoFile', paths.supervisorInfoFile, expectedPaths.supervisorInfoFile],
    ['tokenFile', paths.tokenFile, expectedPaths.tokenFile],
    ['watchesFile', paths.watchesFile, expectedPaths.watchesFile],
    ['logFile', paths.logFile, expectedPaths.logFile],
    ['startupLockDir', paths.startupLockDir, expectedPaths.startupLockDir],
  ];
  const mismatches = pathEntries.filter(
    ([, actual, expected]) => path.resolve(actual) !== path.resolve(expected),
  );

  if (mismatches.length === 0) {
    return;
  }

  const [field, actual, expected] = mismatches[0]!;
  throw new MergeReadyWatchUiRuntimePreflightError(
    `captured agentDir ${JSON.stringify(agentDir)} does not match runner ${field} (${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}).`,
  );
}
