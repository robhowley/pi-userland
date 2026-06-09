import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, createEventBus } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  MERGE_READY_WATCH_STATUS_EVENT,
  createMergeReadyWatchStatusRecord,
} from '../../extensions/merge-ready/index.js';
import { createMergeReadyWatchSessionRunner } from '../../extensions/merge-ready/watch-ui/session-runner.js';
import { getMergeReadyWatchUiPaths } from '../../extensions/merge-ready/watch-ui/supervisor-state.js';

const URL = 'https://github.com/shopify/pi/pull/64';

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
          session: {
            sessionId: 'session-123',
            sessionFile: '/tmp/session-123.jsonl',
            prompt: vi.fn(() => promptDeferred.promise),
            abort: vi.fn(async () => undefined),
            dispose: vi.fn(),
          },
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
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.listWatches()[0]).toMatchObject({
      state: 'stopped',
    });

    await runner.dispose();
  });
});

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
