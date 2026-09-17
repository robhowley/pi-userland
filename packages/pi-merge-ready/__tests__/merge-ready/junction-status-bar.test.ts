import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MERGE_READY_JUNCTION_UPDATE_EVENT,
  type MergeReadyJunctionUpdate,
} from '../../extensions/merge-ready/junction.js';
import { registerMergeReadyCommand } from '../../extensions/merge-ready/commands.js';
import { registerMergeReadyStatusTool } from '../../extensions/merge-ready/tool.js';
import {
  refreshMergeReadyStatusBar,
  registerMergeReadyStatusBar,
  resetMergeReadyStatusBarCache,
  type MergeReadyStatusBarAPI,
  type MergeReadyStatusBarContext,
} from '../../extensions/merge-ready/status-bar.js';
import { createMergeReadyStatus } from '../../extensions/merge-ready/status.js';
import { runMergeReadyWatchLoop } from '../../extensions/merge-ready/watch.js';
import type { MergeReadyStatus } from '../../extensions/merge-ready/types.js';

const GENERATED_AT = '2026-08-28T00:00:00.000Z';

function createReadyStatus(number = 42): MergeReadyStatus {
  return createMergeReadyStatus({
    generatedAt: GENERATED_AT,
    pr: {
      lifecycle: 'open',
      number,
      title: 'Publish merge-ready status',
      url: `https://github.com/robhowley/pi-userland/pull/${String(number)}`,
      headRefName: 'feat/merge-ready',
      baseRefName: 'main',
    },
    signals: {
      mergeability: 'mergeable',
      checks: 'passing',
      review: 'approved',
      unresolvedConversations: false,
      unresolvedConversationRequirement: 'optional',
    },
  });
}

function createUrlStatus(): MergeReadyStatus {
  const status = createReadyStatus();
  return {
    ...status,
    target: {
      mode: 'url',
      url: status.pr!.url,
      owner: 'robhowley',
      repo: 'pi-userland',
      prNumber: status.pr!.number,
    },
  };
}

type TestAPI = MergeReadyStatusBarAPI & {
  events: { emit: ReturnType<typeof vi.fn> };
};

type Handler = (event: unknown, ctx: MergeReadyStatusBarContext) => void | Promise<void>;

function createAPI(): {
  api: TestAPI;
  events: TestAPI['events'];
  getHandler: (event: 'session_start' | 'turn_end' | 'session_shutdown') => Handler | undefined;
} {
  const handlers = new Map<string, Handler>();
  const events = { emit: vi.fn() };
  const api: TestAPI = {
    events,
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
  };

  return {
    api,
    events,
    getHandler: (event) => handlers.get(event),
  };
}

function createContext(): MergeReadyStatusBarContext & { mode: 'print' } {
  return {
    cwd: '/repo',
    mode: 'print',
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function updateCalls(events: { emit: ReturnType<typeof vi.fn> }): MergeReadyJunctionUpdate[] {
  return events.emit.mock.calls
    .filter(([channel]) => channel === MERGE_READY_JUNCTION_UPDATE_EVENT)
    .map(([, update]) => update as MergeReadyJunctionUpdate);
}

beforeEach(() => {
  resetMergeReadyStatusBarCache();
});

describe('Merge Ready status-bar Junction integration', () => {
  it('withdraws on session reset and shutdown, then announces the fresh status', async () => {
    const { api, events, getHandler } = createAPI();
    const status = createReadyStatus();
    registerMergeReadyStatusBar(api, { getStatus: vi.fn(async () => status) });
    const ctx = createContext();

    await getHandler('session_start')?.({ reason: 'startup' }, ctx);
    await getHandler('session_shutdown')?.({}, ctx);

    expect(updateCalls(events)).toEqual([
      { producer: { key: 'pi-merge-ready', label: 'Merge Ready' }, items: [] },
      {
        producer: { key: 'pi-merge-ready', label: 'Merge Ready' },
        items: [
          {
            key: 'current-branch',
            title: 'Current branch PR #42',
            status: '✅ #42 Ready',
            summary: '0 open items',
            href: 'https://github.com/robhowley/pi-userland/pull/42',
          },
        ],
      },
      { producer: { key: 'pi-merge-ready', label: 'Merge Ready' }, items: [] },
    ]);
  });

  it('does not let an older accepted refresh re-emit after a newer owner wins', async () => {
    const { api, events } = createAPI();
    const firstStatus = createReadyStatus(41);
    const latestStatus = createReadyStatus(42);
    const first = createDeferred<MergeReadyStatus>();
    const latest = createDeferred<MergeReadyStatus>();
    const getStatus = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const ctx = createContext();
    registerMergeReadyStatusBar(api);

    const firstRefresh = refreshMergeReadyStatusBar({
      exec: api.exec,
      getStatus,
      ctx,
      force: true,
    });
    const latestRefresh = refreshMergeReadyStatusBar({
      exec: api.exec,
      getStatus,
      ctx,
      force: true,
    });

    latest.resolve(latestStatus);
    await latestRefresh;
    first.resolve(firstStatus);
    await firstRefresh;

    expect(updateCalls(events)).toHaveLength(1);
    expect(updateCalls(events)[0]?.items[0]?.title).toBe('Current branch PR #42');
  });

  it('does not re-emit a refresh that completes after session shutdown', async () => {
    const { api, events, getHandler } = createAPI();
    const pending = createDeferred<MergeReadyStatus>();
    const ctx = createContext();
    registerMergeReadyStatusBar(api, { getStatus: vi.fn(() => pending.promise) });

    const refresh = refreshMergeReadyStatusBar({
      exec: api.exec,
      ctx,
      force: true,
    });
    await getHandler('session_shutdown')?.({}, ctx);
    pending.resolve(createReadyStatus());
    await refresh;

    expect(updateCalls(events)).toEqual([
      { producer: { key: 'pi-merge-ready', label: 'Merge Ready' }, items: [] },
    ]);
  });

  it('publishes current-branch command results but excludes URL commands and direct tools', async () => {
    const { api, events } = createAPI();
    const currentStatus = createReadyStatus();
    const urlStatus = createUrlStatus();
    registerMergeReadyStatusBar(api);

    const registerCommand = vi.fn();
    registerMergeReadyCommand(
      { exec: api.exec, registerCommand },
      { getStatus: vi.fn(async ({ url }) => (url === undefined ? currentStatus : urlStatus)) },
    );
    const command = registerCommand.mock.calls[0]?.[1];
    expect(command).toBeDefined();
    const commandContext = {
      cwd: '/repo',
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    };

    await command!.handler('', commandContext);
    expect(updateCalls(events)).toHaveLength(1);

    events.emit.mockClear();
    await command!.handler(`--url ${urlStatus.target.mode === 'url' ? urlStatus.target.url : ''}`, {
      ...commandContext,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    });
    expect(events.emit).not.toHaveBeenCalled();

    const registerTool = vi.fn();
    registerMergeReadyStatusTool(
      { exec: api.exec, registerTool },
      { getStatus: vi.fn(async () => currentStatus) },
    );
    const registration = registerTool.mock.calls[0]?.[0];
    expect(registration).toBeDefined();
    await registration!.execute('tool-call', {}, undefined, undefined, { cwd: '/repo' });

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('publishes a current-branch watch result but leaves a failed fetch unchanged', async () => {
    const { api, events } = createAPI();
    const ctx = createContext();
    registerMergeReadyStatusBar(api);
    const watchContext = {
      ...ctx,
      ui: {
        ...ctx.ui,
        notify: vi.fn(),
      },
    };

    await runMergeReadyWatchLoop({
      exec: api.exec,
      api: { sendUserMessage: vi.fn() },
      ctx: watchContext,
      intervalSeconds: 1,
      signal: new AbortController().signal,
      dependencies: {
        getStatus: vi.fn(async () => createReadyStatus()),
        sleep: vi.fn(async () => undefined),
        maxIterations: 1,
      },
    });
    expect(updateCalls(events)).toHaveLength(1);

    events.emit.mockClear();
    await expect(
      runMergeReadyWatchLoop({
        exec: api.exec,
        api: { sendUserMessage: vi.fn() },
        ctx: watchContext,
        intervalSeconds: 1,
        signal: new AbortController().signal,
        dependencies: {
          getStatus: vi.fn(async () => {
            throw new Error('provider unavailable');
          }),
          maxIterations: 1,
        },
      }),
    ).rejects.toThrow('provider unavailable');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not publish a watch result that arrives after abort', async () => {
    const { api, events } = createAPI();
    const ctx = createContext();
    registerMergeReadyStatusBar(api);
    const watchContext = {
      ...ctx,
      ui: {
        ...ctx.ui,
        notify: vi.fn(),
      },
    };
    const pending = createDeferred<MergeReadyStatus>();
    const controller = new AbortController();

    const watch = runMergeReadyWatchLoop({
      exec: api.exec,
      api: { sendUserMessage: vi.fn() },
      ctx: watchContext,
      intervalSeconds: 1,
      signal: controller.signal,
      dependencies: {
        getStatus: vi.fn(() => pending.promise),
      },
    });

    controller.abort();
    pending.resolve(createReadyStatus());

    await expect(watch).resolves.toEqual({ kind: 'aborted', reason: 'aborted' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('replaces an ambient failure with an unknown view without retaining its PR link', async () => {
    const { api, events, getHandler } = createAPI();
    const ctx = createContext();
    const getStatus = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    registerMergeReadyStatusBar(api, { getStatus });

    await getHandler('turn_end')?.({}, ctx);

    expect(updateCalls(events)).toEqual([
      {
        producer: { key: 'pi-merge-ready', label: 'Merge Ready' },
        items: [
          {
            key: 'current-branch',
            title: 'Current branch',
            status: '❔ Unknown',
            summary: 'Status unavailable',
          },
        ],
      },
    ]);
  });
});
