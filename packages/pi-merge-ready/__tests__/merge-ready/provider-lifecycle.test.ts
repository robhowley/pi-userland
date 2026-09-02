import { afterEach, describe, expect, it, vi } from 'vitest';
import mergeReadyExtension, {
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
    facts: {
      draft: { kind: 'known' as const, value: false },
      hasConflicts: { kind: 'known' as const, value: false },
      behindBase: { kind: 'known' as const, value: false },
      sourceMergeGate: { kind: 'known' as const, value: 'clear' as const },
      requiredChecks: { kind: 'known' as const, value: [] },
      sourceReviewGate: {
        kind: 'known' as const,
        value: { state: 'satisfied' as const },
      },
      unresolvedConversations: { kind: 'known' as const, value: [] },
      conversationResolutionRequired: { kind: 'known' as const, value: true },
    },
  };
}

function createProvider(title: string): MergeReadyProviderV1 {
  return {
    apiVersion: 1,
    id: 'gitlab',
    matchUrl: (url) =>
      url.href === URL ? { url: URL, owner: 'shop', repo: 'pi', prNumber: 7 } : null,
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

  it('uses the session catalog for status bar, command, and tool', async () => {
    const runtime = createRuntime();
    const provider = createProvider('shared catalog');
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      provider,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    await runtime.command()?.handler(`--url ${URL}`, runtime.ctx);
    const toolResult = await runtime
      .tool()
      ?.execute('call-1', { url: URL }, undefined, undefined, runtime.ctx);

    runtime.assertDone();
    expect(provider.read).toHaveBeenCalledTimes(3);
    expect(runtime.notify).toHaveBeenCalledWith(expect.stringContaining('Ready to merge'), 'info');
    expect(toolResult.details).toMatchObject({ state: 'ready', pr: { title: 'shared catalog' } });
  });

  it('pins an active watch to catalog A while a replacement session and watch use catalog B', async () => {
    vi.useFakeTimers();
    const runtime = createRuntime(2);
    const first = createProvider('catalog A');
    const second = createProvider('catalog B');
    const unsubscribe = registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      first,
    );
    mergeReadyExtension(runtime.api as unknown as Parameters<typeof mergeReadyExtension>[0]);

    await runtime.startSession();
    const watchContextA = {
      ...runtime.ctx,
      sessionManager: { getSessionId: () => 'session-a' },
    };
    const watchA = runtime.command()?.handler(`watch --url ${URL} --interval 15`, watchContextA);
    await flushMicrotasks();
    expect(first.read).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerMergeReadyProvider(
      runtime.api as Parameters<typeof registerMergeReadyProvider>[0],
      second,
    );
    await runtime.startSession('reload');
    expect(second.read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    expect(first.read).toHaveBeenCalledTimes(3);
    expect(second.read).toHaveBeenCalledTimes(1);

    await runtime.command()?.handler(`--url ${URL}`, runtime.ctx);
    expect(second.read).toHaveBeenCalledTimes(2);

    const watchContextB = {
      ...runtime.ctx,
      sessionManager: { getSessionId: () => 'session-b' },
    };
    const watchB = runtime.command()?.handler(`watch --url ${URL} --interval 15`, watchContextB);
    await flushMicrotasks();
    expect(second.read).toHaveBeenCalledTimes(3);
    runtime.assertDone();

    await runtime.shutdown(watchContextA);
    await runtime.shutdown(watchContextB);
    await watchA;
    await watchB;
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
