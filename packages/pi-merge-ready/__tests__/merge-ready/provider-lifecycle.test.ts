import { afterEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
  getActiveMergeReadyWatch,
  MERGE_READY_COMMAND_NAME,
  MERGE_READY_STATUS_TOOL_NAME,
  registerMergeReadyProvider,
  resetMergeReadyStatusBarCache,
  resetMergeReadyWatchState,
  type MergeReadyProviderV1,
} from '../../extensions/merge-ready/index.js';
import { createFakeExec, createGitDiscoveryCalls } from './test-fixtures.js';

const URL = 'https://gitlab.example/shop/pi/-/merge_requests/7';
const REMOTE_URL = 'ssh://git@gitlab.example/shop/pi.git';

function found(title: string) {
  return {
    kind: 'found' as const,
    pullRequest: {
      lifecycle: 'open' as const,
      number: 7,
      title,
      url: URL,
      headRefName: 'feat/providers',
      baseRefName: 'main',
    },
    signals: {
      draft: false,
      mergeability: 'mergeable' as const,
      checks: 'passing' as const,
      review: 'approved' as const,
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'required' as const,
    },
  };
}

function createProvider(title: string, id = 'gitlab'): MergeReadyProviderV1 {
  return {
    apiVersion: 1,
    id,
    matchUrl: vi.fn((url) =>
      url.href === URL ? { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 } : null,
    ),
    matchRemote: (remote) => (remote.url === REMOTE_URL ? { owner: 'shop', repo: 'pi' } : null),
    read: vi.fn(async () => found(title)),
  };
}

function createAmbientCalls(count = 1) {
  return Array.from({ length: count }, () => {
    const calls = createGitDiscoveryCalls({ timeout: 8_000 });
    const remoteCall = calls.find((call) => call.args.join(' ') === 'remote get-url origin');
    if (remoteCall?.result) remoteCall.result.stdout = `${REMOTE_URL}\n`;
    return calls;
  }).flat();
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createRuntime(expectedSessionStarts = 1) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const lifecycle = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, any>();
  const { exec, assertDone } = createFakeExec(createAmbientCalls(expectedSessionStarts));
  const setStatus = vi.fn();
  const notify = vi.fn();

  const api = {
    events: {
      on(event: string, listener: (payload: unknown) => void) {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
        return () => eventListeners.delete(listener);
      },
      emit(event: string, payload: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      },
    },
    on: vi.fn((event: string, handler: (event: unknown, ctx: any) => unknown) => {
      lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    sendUserMessage: vi.fn(async () => undefined),
    exec,
  };

  const ctx = {
    cwd: '/repo',
    hasUI: true,
    isProjectTrusted: () => false,
    ui: { setStatus, notify },
  };

  return {
    api,
    ctx,
    setStatus,
    notify,
    assertDone,
    command: () => commands.get(MERGE_READY_COMMAND_NAME),
    tool: () => tools.get(MERGE_READY_STATUS_TOOL_NAME),
    async startSession(reason = 'startup') {
      for (const handler of lifecycle.get('session_start') ?? []) {
        await handler({ reason }, ctx);
      }
    },
    async shutdown(shutdownCtx = ctx) {
      for (const handler of lifecycle.get('session_shutdown') ?? []) {
        await handler({ reason: 'shutdown' }, shutdownCtx);
      }
    },
  };
}

afterEach(async () => {
  await resetMergeReadyWatchState();
  resetMergeReadyStatusBarCache();
  vi.useRealTimers();
});

describe('merge-ready custom provider lifecycle', () => {
  it.each(['core-first', 'provider-first'] as const)(
    'collects before the initial refresh with %s extension load order',
    async (order) => {
      const runtime = createRuntime();
      const provider = createProvider(order);
      const loadCore = () =>
        mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);
      const loadProvider = () =>
        registerMergeReadyProvider(
          runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
          provider,
        );

      if (order === 'core-first') {
        loadCore();
        loadProvider();
      } else {
        loadProvider();
        loadCore();
      }

      await runtime.startSession();

      runtime.assertDone();
      expect(provider.read).toHaveBeenCalledTimes(1);
      expect(runtime.setStatus).toHaveBeenCalledWith('merge-ready', '✅ #7 Ready');
    },
  );

  it('uses one session provider for status bar, command, JSON, and tool', async () => {
    const runtime = createRuntime();
    const provider = createProvider('shared provider');
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      provider,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    await runtime.command()?.handler(`--url ${URL}`, runtime.ctx);
    await runtime.command()?.handler(`--json --url ${URL}`, runtime.ctx);
    const toolResult = await runtime
      .tool()
      ?.execute('call-1', { url: URL }, undefined, undefined, runtime.ctx);

    runtime.assertDone();
    expect(provider.read).toHaveBeenCalledTimes(4);
    expect(provider.matchUrl).toHaveBeenCalledTimes(3);
    expect(runtime.notify).toHaveBeenCalledWith(expect.stringContaining('Ready to merge'), 'info');
    expect(runtime.notify).toHaveBeenCalledWith(expect.stringContaining(`"url": "${URL}"`), 'info');
    expect(toolResult.details).toMatchObject({ state: 'ready', pr: { title: 'shared provider' } });
  });

  it('reports URL matcher failures without starting a watch', async () => {
    const runtime = createRuntime();
    const provider = createProvider('broken matcher');
    provider.matchUrl = vi.fn(() => {
      throw new Error('matcher boom');
    });
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      provider,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    runtime.setStatus.mockClear();
    runtime.notify.mockClear();
    await expect(
      runtime.command()?.handler(`watch --url ${URL} --interval 15`, runtime.ctx),
    ).resolves.toBeUndefined();

    runtime.assertDone();
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(getActiveMergeReadyWatch(runtime.api)).toBeNull();
    expect(runtime.setStatus).not.toHaveBeenCalled();
    expect(runtime.notify.mock.calls).toEqual([
      ['Merge-ready provider "gitlab" URL matcher failed: matcher boom', 'error'],
    ]);
  });

  it('reports overlapping URL matches without starting a watch', async () => {
    const runtime = createRuntime();
    const first = createProvider('first matcher');
    const second = createProvider('second matcher', 'gitlab-secondary');
    second.matchRemote = vi.fn(() => null);
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      first,
    );
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      second,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    runtime.setStatus.mockClear();
    runtime.notify.mockClear();
    await expect(
      runtime.command()?.handler(`watch --url ${URL} --interval 15`, runtime.ctx),
    ).resolves.toBeUndefined();

    runtime.assertDone();
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(second.read).not.toHaveBeenCalled();
    expect(first.matchUrl).toHaveBeenCalledTimes(1);
    expect(second.matchUrl).toHaveBeenCalledTimes(1);
    expect(getActiveMergeReadyWatch(runtime.api)).toBeNull();
    expect(runtime.setStatus).not.toHaveBeenCalled();
    expect(runtime.notify.mock.calls).toEqual([
      [
        'Multiple merge-ready providers matched "https://gitlab.example/shop/pi/-/merge_requests/7": gitlab, gitlab-secondary.',
        'error',
      ],
    ]);
  });

  it('stops an active watch before clearing providers', async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const provider = createProvider('watch provider');
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      provider,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    const watchContext = {
      ...runtime.ctx,
      sessionManager: { getSessionId: () => 'session-a' },
    };
    const watch = runtime.command()?.handler(`watch --url ${URL} --interval 15`, watchContext);
    await flushMicrotasks();
    expect(provider.matchUrl).toHaveBeenCalledTimes(1);
    expect(provider.read).toHaveBeenCalledTimes(2);

    await runtime.shutdown(watchContext);
    await watch;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(provider.read).toHaveBeenCalledTimes(2);
    runtime.assertDone();
  });

  it('recollects providers for a later session', async () => {
    const runtime = createRuntime(2);
    const first = createProvider('first session');
    const second = createProvider('second session');
    const unsubscribe = registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      first,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    unsubscribe();
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      second,
    );
    await runtime.startSession('reload');
    const result = await runtime
      .tool()
      ?.execute('call-2', { url: URL }, undefined, undefined, runtime.ctx);

    runtime.assertDone();
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(second.read).toHaveBeenCalledTimes(2);
    expect(result.details.pr.title).toBe('second session');
  });
});
