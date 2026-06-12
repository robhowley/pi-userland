import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createEventBus,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMergeReadyStatus,
  resetMergeReadyWatchState,
  startMergeReadyWatch,
  stopActiveMergeReadyWatch,
  type MergeReadyStatus,
} from '../../extensions/merge-ready/index.js';
import {
  MERGE_READY_WATCH_STATUS_EVENT,
  createMergeReadyWatchStatusRecord,
} from '../../extensions/merge-ready/watch-status.js';
import {
  createMergeReadyWatchSessionRunner,
  type MergeReadyWatchSessionLike,
} from '../../extensions/merge-ready/watch-ui/session-runner.js';
import type { MergeReadyWatchUiRuntimeSnapshot } from '../../extensions/merge-ready/watch-ui/runtime-snapshot.js';
import { getMergeReadyWatchUiPaths } from '../../extensions/merge-ready/watch-ui/supervisor-state.js';

const URL = 'https://github.com/shopify/pi/pull/64';
const BASE_MODEL: MergeReadyWatchUiRuntimeSnapshot['model'] = {
  id: 'claude-sonnet-4-20250514',
  name: 'Claude Sonnet 4',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1/messages',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

afterEach(async () => {
  await resetMergeReadyWatchState();
});

describe('merge-ready watch UI session runner', () => {
  it('dedupes watches by canonical URL and updates persisted state from live status events', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();
    let eventBus = createEventBus();

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createEventBus: () => eventBus,
        createResourceLoader: vi.fn((options) => {
          eventBus = options.eventBus;
          return {
            reload: vi.fn(async () => undefined),
          };
        }),
        createSession: vi.fn(async (_options) => ({
          session: createMockSession({ prompt: vi.fn(() => promptDeferred.promise) }),
        })),
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    const first = await runner.addWatch({ url: URL });
    expect(first.created).toBe(true);
    expect(runner.listWatches()).toHaveLength(1);

    const duplicate = await runner.addWatch({ url: `${URL}/` });
    expect(duplicate.created).toBe(false);
    expect(duplicate.message).toContain('Watch already exists');
    expect(runner.listWatches()).toHaveLength(1);

    eventBus.emit(
      MERGE_READY_WATCH_STATUS_EVENT,
      createMergeReadyWatchStatusRecord({
        lifecycle: 'watching',
        requestedUrl: URL,
        session: {
          sessionId: 'session-123',
          sessionFile: '/tmp/session-123.jsonl',
        },
        summary: 'Checks are still running',
        updatedAt: '2026-06-08T12:05:00.000Z',
      }),
    );

    expect(runner.listWatches()[0]).toMatchObject({
      canonicalUrl: URL,
      lastStatus: {
        lifecycle: 'watching',
        summary: 'Checks are still running',
      },
      state: 'active',
    });

    promptDeferred.resolve();
    await flushAsyncWork();

    expect(runner.listWatches()[0]).toMatchObject({
      state: 'stopped',
    });

    await runner.dispose();
  });

  it('keeps different PR watches active concurrently across child sessions and preserves same-PR dedupe', async () => {
    const secondUrl = 'https://github.com/shopify/pi/pull/65';
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const sessionSpecs = [
      {
        sessionId: 'session-64',
        sessionFile: '/tmp/session-64.jsonl',
        url: URL,
        prNumber: 64,
      },
      {
        sessionId: 'session-65',
        sessionFile: '/tmp/session-65.jsonl',
        url: secondUrl,
        prNumber: 65,
      },
    ];
    let sessionIndex = 0;

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createResourceLoader: vi.fn(() => ({
          reload: vi.fn(async () => undefined),
        })),
        createSession: vi.fn(async (options) => {
          const spec = sessionSpecs[sessionIndex++];
          expect(spec).toBeDefined();
          return {
            session: createMockConcurrentWatchSession({
              cwd: options.cwd,
              sessionId: spec!.sessionId,
              sessionFile: spec!.sessionFile,
              url: spec!.url,
              owner: 'shopify',
              repo: 'pi',
              prNumber: spec!.prNumber,
            }),
          };
        }),
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    const first = await runner.addWatch({ url: URL });
    const second = await runner.addWatch({ url: secondUrl });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(runner.getWatch(first.watch.id)).toMatchObject({
      canonicalUrl: URL,
      state: 'active',
    });
    expect(runner.getWatch(second.watch.id)).toMatchObject({
      canonicalUrl: secondUrl,
      state: 'active',
    });

    const duplicate = await runner.addWatch({ url: `${URL}/` });
    expect(duplicate.created).toBe(false);
    expect(runner.listWatches()).toHaveLength(2);

    await runner.stopWatch(first.watch.id);
    expect(runner.getWatch(first.watch.id)).toMatchObject({ state: 'stopped' });
    expect(runner.getWatch(second.watch.id)).toMatchObject({ state: 'active' });

    await runner.stopWatch(second.watch.id);
    expect(runner.getWatch(second.watch.id)).toMatchObject({ state: 'stopped' });

    await runner.dispose();
  });

  it('normalizes explicit cwd inputs before persisting and creating a session', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const relativeCwd = `nested${path.sep}.${path.sep}repo`;
    const explicitCwd = path.join(defaultCwd, 'nested', 'repo');
    await mkdir(explicitCwd, { recursive: true });
    const expectedCwd = await realpath(explicitCwd);
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();
    const createResourceLoader = vi.fn(() => ({
      reload: vi.fn(async () => undefined),
    }));
    const createSession = vi.fn(async (_options) => ({
      session: createMockSession({ prompt: vi.fn(() => promptDeferred.promise) }),
    }));

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createResourceLoader,
        createSession,
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    const added = await runner.addWatch({ url: URL, cwd: `  ${relativeCwd}  ` });

    expect(added).toMatchObject({
      created: true,
      watch: {
        canonicalUrl: URL,
        cwd: expectedCwd,
      },
    });
    expect(createResourceLoader).toHaveBeenCalledWith(expect.objectContaining({ cwd: expectedCwd }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: expectedCwd }));

    const persistedWatches = await readFile(paths.watchesFile, 'utf8');
    expect(persistedWatches).toContain(expectedCwd);
    expect(persistedWatches).not.toContain(relativeCwd);

    promptDeferred.resolve();
    await flushAsyncWork();
    await runner.dispose();
  });

  it('treats blank cwd like omitted and persists the normalized default cwd', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const expectedDefaultCwd = await realpath(defaultCwd);
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();
    const createSession = vi.fn(async (_options) => ({
      session: createMockSession({ prompt: vi.fn(() => promptDeferred.promise) }),
    }));

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createResourceLoader: vi.fn(() => ({
          reload: vi.fn(async () => undefined),
        })),
        createSession,
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    const added = await runner.addWatch({ url: URL, cwd: '   ' });

    expect(added).toMatchObject({
      created: true,
      watch: {
        cwd: expectedDefaultCwd,
      },
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: expectedDefaultCwd }),
    );

    promptDeferred.resolve();
    await flushAsyncWork();
    await runner.dispose();
  });

  it('rejects nonexistent cwd values clearly before creating a session', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const missingCwd = path.join(defaultCwd, 'missing-repo');
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const createResourceLoader = vi.fn();
    const createSession = vi.fn();

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createResourceLoader: createResourceLoader as never,
        createSession: createSession as never,
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    await expect(runner.addWatch({ url: URL, cwd: missingCwd })).rejects.toThrow(
      `cwd does not exist: ${JSON.stringify(missingCwd)}`,
    );
    expect(createResourceLoader).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('rejects non-directory cwd values clearly before creating a session', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const fileCwd = path.join(defaultCwd, 'not-a-directory.txt');
    await writeFile(fileCwd, 'hello');
    const expectedFileCwd = await realpath(fileCwd);
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const createResourceLoader = vi.fn();
    const createSession = vi.fn();

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createResourceLoader: createResourceLoader as never,
        createSession: createSession as never,
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    await expect(runner.addWatch({ url: URL, cwd: fileCwd })).rejects.toThrow(
      `cwd is not a directory: ${JSON.stringify(expectedFileCwd)}`,
    );
    expect(createResourceLoader).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('returns a cwd-aware duplicate message when the same PR is requested from a different cwd', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const firstCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-first-'));
    const secondCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-second-'));
    const expectedFirstCwd = await realpath(firstCwd);
    const expectedSecondCwd = await realpath(secondCwd);
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd: firstCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir,
        createResourceLoader: vi.fn(() => ({
          reload: vi.fn(async () => undefined),
        })),
        createSession: vi.fn(async (_options) => ({
          session: createMockSession({ prompt: vi.fn(() => promptDeferred.promise) }),
        })),
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    await runner.addWatch({ url: URL });
    const duplicate = await runner.addWatch({ url: URL, cwd: secondCwd });

    expect(duplicate.created).toBe(false);
    expect(duplicate.message).toContain(`Current cwd: ${JSON.stringify(expectedFirstCwd)}`);
    expect(duplicate.message).toContain(`Requested cwd: ${JSON.stringify(expectedSecondCwd)}`);
    expect(duplicate.message).toContain('Remove the existing watch and recreate it');
    expect(runner.listWatches()).toHaveLength(1);

    promptDeferred.resolve();
    await flushAsyncWork();
    await runner.dispose();
  });

  it('executes the registered merge-ready command directly when duplicate invocation names are present', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const defaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const watchDeferred = createDeferred<void>();
    const prompt = vi.fn(async () => undefined);
    const commandContext = {
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };
    const mergeReadyHandler = vi.fn(() => watchDeferred.promise);

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        createResourceLoader: vi.fn(() => ({
          reload: vi.fn(async () => undefined),
        })),
        createSession: vi.fn(async (_options) => ({
          session: createMockSession({
            prompt,
            extensionRunner: {
              createCommandContext: vi.fn(() => commandContext),
              getRegisteredCommands: vi.fn(() => [
                {
                  name: 'merge-ready',
                  invocationName: 'merge-ready:1',
                  handler: mergeReadyHandler,
                },
                {
                  name: 'merge-ready',
                  invocationName: 'merge-ready:2',
                  handler: vi.fn(async () => undefined),
                },
              ]),
            },
          }),
        })),
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    await runner.addWatch({ url: URL });

    expect(mergeReadyHandler).toHaveBeenCalledWith(`watch --url ${URL}`, commandContext);
    expect(prompt).not.toHaveBeenCalled();

    watchDeferred.resolve();
    await flushAsyncWork();

    expect(runner.listWatches()[0]).toMatchObject({
      state: 'stopped',
    });

    await runner.dispose();
  });

  it('injects explicit runtime objects into child sessions and preserves the captured agentDir', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const snapshotDefaultCwd = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-default-'));
    const expectedSnapshotDefaultCwd = await realpath(snapshotDefaultCwd);
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();
    const authStorage = AuthStorage.inMemory();
    let authStoragePath: string | undefined;
    let modelRegistryPath: string | undefined;

    const createResourceLoader = vi.fn((_options) => ({
      reload: vi.fn(async () => undefined),
    }));
    const createSession = vi.fn(async (_options) => ({
      session: createMockSession({ prompt: vi.fn(() => promptDeferred.promise) }),
    }));

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd: '/runner-default',
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      runtimeSnapshot: createRuntimeSnapshot(agentDir, {
        defaultCwd: snapshotDefaultCwd,
        auth: {
          provider: 'anthropic',
          apiKey: 'sk-runtime-secret',
          headers: {
            Authorization: 'Bearer runtime-secret',
            'anthropic-beta': 'tools-2025-06-09',
          },
        },
      }),
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        agentDir: '/tmp/wrong-agent-dir',
        createAuthStorage: vi.fn((receivedAuthStoragePath) => {
          authStoragePath = receivedAuthStoragePath;
          return authStorage;
        }),
        createModelRegistry: vi.fn((receivedAuthStorage, receivedModelRegistryPath) => {
          expect(receivedAuthStorage).toBe(authStorage);
          modelRegistryPath = receivedModelRegistryPath;
          return ModelRegistry.inMemory(receivedAuthStorage);
        }),
        createResourceLoader,
        createSession,
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    expect(runner.getDefaultCwd()).toBe(snapshotDefaultCwd);

    await runner.addWatch({ url: URL });

    expect(createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir, cwd: expectedSnapshotDefaultCwd }),
    );
    expect(authStoragePath).toBe(path.join(agentDir, 'auth.json'));
    expect(modelRegistryPath).toBe(path.join(agentDir, 'models.json'));
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir,
        authStorage,
        model: expect.objectContaining({
          provider: 'anthropic',
          id: BASE_MODEL.id,
          headers: {
            Authorization: 'Bearer runtime-secret',
            'anthropic-beta': 'tools-2025-06-09',
          },
        }),
        thinkingLevel: 'high',
      }),
    );

    promptDeferred.resolve();
    await flushAsyncWork();
    await runner.dispose();
  });

  it('fails fast when the captured runtime still contains unresolved auth placeholders', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const createSession = vi.fn();

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd: agentDir,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      runtimeSnapshot: createRuntimeSnapshot(agentDir, {
        auth: {
          provider: 'anthropic',
          apiKey: '$PI_PROXY_API_KEY',
          headers: {
            Authorization: '$PI_PROXY_API_KEY',
          },
        },
      }),
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        createResourceLoader: vi.fn(() => ({
          reload: vi.fn(async () => undefined),
        })),
        createSession: createSession as never,
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    await expect(runner.addWatch({ url: URL })).rejects.toThrow(
      'Merge-ready watch UI runtime-preflight failed: runtime snapshot auth apiKey still looks unresolved',
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('does not persist runtime secrets into watch state or auth storage', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();
    const apiKey = 'sk-super-secret-runtime-key';
    const authorization = 'Bearer runtime-secret-token';
    const secretHeaderValue = 'runtime-secret-header';

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd: agentDir,
      extensionDir: '/pkg/dist/extensions/merge-ready',
      paths,
      runtimeSnapshot: createRuntimeSnapshot(agentDir, {
        auth: {
          provider: 'anthropic',
          apiKey,
          headers: {
            Authorization: authorization,
            'x-runtime-secret': secretHeaderValue,
          },
        },
      }),
      skillPath: '/pkg/skills/merge-ready-loop/SKILL.md',
      dependencies: {
        createResourceLoader: vi.fn(() => ({
          reload: vi.fn(async () => undefined),
        })),
        createSession: vi.fn(async (_options) => ({
          session: createMockSession({ prompt: vi.fn(() => promptDeferred.promise) }),
        })),
        createSessionManager: (cwd) => SessionManager.inMemory(cwd),
      },
    });

    await runner.addWatch({ url: URL });
    promptDeferred.resolve();
    await flushAsyncWork();
    await runner.dispose();

    const persistedWatches = await readFile(paths.watchesFile, 'utf8');
    expect(persistedWatches).not.toContain(apiKey);
    expect(persistedWatches).not.toContain(authorization);
    expect(persistedWatches).not.toContain(secretHeaderValue);

    const persistedAuthStorage = await readFile(path.join(agentDir, 'auth.json'), 'utf8');
    expect(persistedAuthStorage).not.toContain(apiKey);
    expect(persistedAuthStorage).not.toContain(authorization);
    expect(persistedAuthStorage).not.toContain(secretHeaderValue);
  });
});

type MergeReadyWatchStartHookPayload = {
  ok: boolean;
  level: 'info' | 'warning' | 'error';
  message: string;
};

function createMockConcurrentWatchSession(options: {
  cwd: string;
  sessionId: string;
  sessionFile: string;
  url: string;
  owner: string;
  repo: string;
  prNumber: number;
}): MergeReadyWatchSessionLike {
  const api = {
    sendUserMessage: vi.fn(async () => undefined),
  };
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const sleep = createAbortableWatchSleep();
  const status = createReadyUrlStatus({
    url: options.url,
    owner: options.owner,
    repo: options.repo,
    prNumber: options.prNumber,
  });
  const handler = vi.fn(
    async (
      _args: string,
      commandContext?: { onMergeReadyWatchStart?: (result: MergeReadyWatchStartHookPayload) => void },
    ) => {
      const start = startMergeReadyWatch({
        api,
        ctx: {
          cwd: options.cwd,
          mode: 'rpc',
          sessionManager: {
            getSessionId: () => options.sessionId,
            getSessionFile: () => options.sessionFile,
          },
          ui,
        },
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        intervalSeconds: 15,
        url: options.url,
        dependencies: {
          getStatus: vi.fn(async () => status),
          sleep,
          syncStatusBar: vi.fn(),
          checkDirtyWorkingTree: vi.fn(async () => ({ ok: true as const, dirty: false })),
        },
      });

      commandContext?.onMergeReadyWatchStart?.({
        ok: start.ok,
        level: start.level,
        message: start.message,
      });

      if (start.ok) {
        await start.promise;
      }
    },
  );

  return createMockSession({
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
    abort: vi.fn(async () => {
      stopActiveMergeReadyWatch(api);
    }),
    extensionRunner: {
      createCommandContext: vi.fn(() => ({})),
      getRegisteredCommands: vi.fn(() => [
        {
          name: 'merge-ready',
          invocationName: 'merge-ready',
          handler,
        },
      ]),
    },
  });
}

function createReadyUrlStatus(options: {
  url: string;
  owner: string;
  repo: string;
  prNumber: number;
}): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: '2026-06-12T00:00:00.000Z',
    target: {
      mode: 'url',
      url: options.url,
      owner: options.owner,
      repo: options.repo,
      prNumber: options.prNumber,
    },
    pr: {
      lifecycle: 'open',
      number: options.prNumber,
      title: `Watch ${String(options.prNumber)}`,
      url: options.url,
      headRefName: `feat/watch-${String(options.prNumber)}`,
      baseRefName: 'main',
    },
    signals: {
      draft: false,
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createAbortableWatchSleep() {
  return vi.fn((_ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }

    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  });
}

function createRuntimeSnapshot(
  agentDir: string,
  overrides: Partial<MergeReadyWatchUiRuntimeSnapshot> = {},
): MergeReadyWatchUiRuntimeSnapshot {
  const base: MergeReadyWatchUiRuntimeSnapshot = {
    sdkVersion: '0.74.0',
    agentDir,
    defaultCwd: agentDir,
    model: {
      ...BASE_MODEL,
    },
    thinkingLevel: 'high',
    auth: {
      provider: BASE_MODEL.provider,
      apiKey: 'sk-default-runtime-key',
      headers: {
        Authorization: 'Bearer default-runtime-secret',
      },
    },
    signature: 'snapshot-signature',
  };

  const headers =
    overrides.auth?.headers === undefined
      ? base.auth.headers
      : {
          ...base.auth.headers,
          ...overrides.auth.headers,
        };

  return {
    ...base,
    ...overrides,
    model: {
      ...base.model,
      ...overrides.model,
    },
    auth: {
      ...base.auth,
      ...overrides.auth,
      ...(headers === undefined ? {} : { headers }),
    },
  };
}

function createMockSession(
  overrides: Partial<MergeReadyWatchSessionLike> = {},
): MergeReadyWatchSessionLike {
  return {
    sessionId: 'session-123',
    sessionFile: '/tmp/session-123.jsonl',
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...overrides,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
