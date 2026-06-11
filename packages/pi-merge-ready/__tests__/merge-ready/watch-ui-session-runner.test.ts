import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createEventBus,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  MERGE_READY_WATCH_STATUS_EVENT,
  createMergeReadyWatchStatusRecord,
} from '../../extensions/merge-ready/index.js';
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

describe('merge-ready watch UI session runner', () => {
  it('dedupes watches by canonical URL and updates persisted state from live status events', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
    const paths = getMergeReadyWatchUiPaths(agentDir);
    const promptDeferred = createDeferred<void>();
    let eventBus = createEventBus();

    const runner = await createMergeReadyWatchSessionRunner({
      defaultCwd: '/repo',
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

  it('executes the registered merge-ready command directly when duplicate invocation names are present', async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'merge-ready-watch-ui-agent-'));
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
      defaultCwd: '/repo',
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
        defaultCwd: '/snapshot-default',
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

    expect(runner.getDefaultCwd()).toBe('/snapshot-default');

    await runner.addWatch({ url: URL });

    expect(createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir, cwd: '/snapshot-default' }),
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
      defaultCwd: '/repo',
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
      defaultCwd: '/repo',
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

function createRuntimeSnapshot(
  agentDir: string,
  overrides: Partial<MergeReadyWatchUiRuntimeSnapshot> = {},
): MergeReadyWatchUiRuntimeSnapshot {
  const base: MergeReadyWatchUiRuntimeSnapshot = {
    sdkVersion: '0.74.0',
    agentDir,
    defaultCwd: '/repo',
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
