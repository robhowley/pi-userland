import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatchUiRuntimeSnapshot } from '../../extensions/merge-ready/watch-ui/runtime-snapshot.js';

const SDK_VERSION = '0.78.1';
const mocked = vi.hoisted(() => ({
  readWatchUiRuntimeSnapshotHandoff: vi.fn(),
  createMergeReadyWatchSessionRunner: vi.fn(),
  createMergeReadyWatchUiSupervisorServer: vi.fn(),
  ensureMergeReadyWatchUiStateDir: vi.fn(async () => undefined),
  ensureMergeReadyWatchUiToken: vi.fn(async () => 'token-123'),
  removeMergeReadyWatchSupervisorInfo: vi.fn(async () => undefined),
  writeMergeReadyWatchSupervisorInfo: vi.fn(async (_paths: unknown, _info: unknown) => undefined),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  VERSION: '0.78.1',
}));
vi.mock('../../extensions/merge-ready/watch-ui/runtime-snapshot.js', () => ({
  readWatchUiRuntimeSnapshotHandoff: mocked.readWatchUiRuntimeSnapshotHandoff,
}));
vi.mock('../../extensions/merge-ready/watch-ui/session-runner.js', () => ({
  createMergeReadyWatchSessionRunner: mocked.createMergeReadyWatchSessionRunner,
}));
vi.mock('../../extensions/merge-ready/watch-ui/supervisor-server.js', () => ({
  createMergeReadyWatchUiSupervisorServer: mocked.createMergeReadyWatchUiSupervisorServer,
}));
vi.mock('../../extensions/merge-ready/watch-ui/supervisor-state.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../extensions/merge-ready/watch-ui/supervisor-state.js')
    >();
  return {
    ...actual,
    ensureMergeReadyWatchUiStateDir: mocked.ensureMergeReadyWatchUiStateDir,
    ensureMergeReadyWatchUiToken: mocked.ensureMergeReadyWatchUiToken,
    removeMergeReadyWatchSupervisorInfo: mocked.removeMergeReadyWatchSupervisorInfo,
    writeMergeReadyWatchSupervisorInfo: mocked.writeMergeReadyWatchSupervisorInfo,
  };
});

import { runMergeReadyWatchUiSupervisorMain } from '../../extensions/merge-ready/watch-ui/supervisor-main.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('merge-ready watch UI supervisor main', () => {
  it('loads the runtime snapshot before creating the runner and exposes only non-secret snapshot metadata', async () => {
    const snapshot: WatchUiRuntimeSnapshot = {
      sdkVersion: SDK_VERSION,
      agentDir: '/tmp/agent-dir',
      defaultCwd: '/tmp/repo',
      model: {
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
      },
      thinkingLevel: 'high',
      auth: {
        provider: 'anthropic',
        apiKey: 'sk-runtime-secret',
        headers: {
          Authorization: 'Bearer runtime-secret',
        },
      },
      signature: 'runtime-signature-1',
    };
    const runner = {
      dispose: vi.fn(async () => undefined),
    };
    const server = {
      port: 43123,
      startedAt: '2026-06-10T12:00:00.000Z',
      close: vi.fn(async () => undefined),
    };

    mocked.readWatchUiRuntimeSnapshotHandoff.mockResolvedValue(snapshot);
    mocked.createMergeReadyWatchSessionRunner.mockResolvedValue(runner);
    mocked.createMergeReadyWatchUiSupervisorServer.mockResolvedValue(server);
    vi.spyOn(process, 'once').mockImplementation(() => process as never);

    await runMergeReadyWatchUiSupervisorMain([
      '--runtime-snapshot',
      '/tmp/runtime-snapshot.json',
      '--cwd',
      '/tmp/repo',
      '--agent-dir',
      '/tmp/agent-dir',
    ]);

    expect(mocked.readWatchUiRuntimeSnapshotHandoff).toHaveBeenCalledWith(
      '/tmp/runtime-snapshot.json',
      {
        expectedSdkVersion: SDK_VERSION,
      },
    );
    expect(mocked.createMergeReadyWatchSessionRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultCwd: '/tmp/repo',
        runtimeSnapshot: snapshot,
      }),
    );
    expect(mocked.createMergeReadyWatchUiSupervisorServer).toHaveBeenCalledWith(
      expect.objectContaining({
        runner,
        token: 'token-123',
        snapshotLoaded: true,
        snapshotSignature: snapshot.signature,
      }),
    );
    expect(mocked.writeMergeReadyWatchSupervisorInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        defaultCwd: '/tmp/repo',
        snapshotLoaded: true,
        snapshotSignature: snapshot.signature,
      }),
    );

    const writtenInfo = mocked.writeMergeReadyWatchSupervisorInfo.mock.calls[0]?.[1];
    expect(JSON.stringify(writtenInfo)).not.toContain('sk-runtime-secret');
    expect(JSON.stringify(writtenInfo)).not.toContain('Bearer runtime-secret');
  });
});
