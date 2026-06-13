import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => undefined),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  VERSION: '0.78.1',
  getAgentDir: () => '/Users/me/.pi/default-agent',
}));
import {
  createMergeReadyWatchUiOpenCommand,
  launchMergeReadyWatchUIWithDependencies,
  resolveMergeReadyWatchUiAgentDir,
  resolveMergeReadyWatchUiPackageRoot,
  resolveMergeReadyWatchUiSupervisorMainPath,
  stopMergeReadyWatchUIWithDependencies,
} from '../../extensions/merge-ready/watch-ui/launcher.js';
import {
  createMergeReadyWatchUiUrl,
  type MergeReadyWatchUiHealth,
} from '../../extensions/merge-ready/watch-ui/supervisor-client.js';
import {
  MERGE_READY_WATCH_UI_SERVICE,
  type MergeReadyWatchSupervisorInfo,
} from '../../extensions/merge-ready/watch-ui/supervisor-state.js';
import {
  type WatchUiRuntimeSnapshot,
  type WatchUiRuntimeModel,
} from '../../extensions/merge-ready/watch-ui/runtime-snapshot.js';

const PATHS = {
  stateDir: '/tmp/merge-ready/watch-ui',
  supervisorInfoFile: '/tmp/merge-ready/watch-ui/supervisor.json',
  tokenFile: '/tmp/merge-ready/watch-ui/token',
  watchesFile: '/tmp/merge-ready/watch-ui/watches.json',
  logFile: '/tmp/merge-ready/watch-ui/supervisor.log',
  startupLockDir: '/tmp/merge-ready/watch-ui/startup.lock',
};

const MODEL: WatchUiRuntimeModel = {
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

const SNAPSHOT: WatchUiRuntimeSnapshot = {
  sdkVersion: '0.78.1',
  agentDir: '/Users/me/.pi/agent-or',
  defaultCwd: '/repo',
  model: MODEL,
  thinkingLevel: 'high',
  auth: {
    provider: 'anthropic',
    apiKey: 'sk-live',
    headers: {
      'x-test-header': 'header-value',
    },
  },
  signature: 'runtime-signature-1',
};

const SUPERVISOR_INFO: MergeReadyWatchSupervisorInfo = {
  service: MERGE_READY_WATCH_UI_SERVICE,
  pid: 42,
  port: 43123,
  startedAt: '2026-06-08T12:00:00.000Z',
  packageVersion: '0.6.0',
  tokenFile: PATHS.tokenFile,
  defaultCwd: '/repo',
  extensionDir: '/pkg/dist/extensions/merge-ready',
  extensionEntryPath: '/pkg/dist/extensions/merge-ready/index.js',
  snapshotLoaded: true,
  snapshotSignature: SNAPSHOT.signature,
};

const SUPERVISOR_HEALTH: MergeReadyWatchUiHealth = {
  service: MERGE_READY_WATCH_UI_SERVICE,
  pid: 42,
  port: 43123,
  startedAt: '2026-06-08T12:00:00.000Z',
  packageVersion: '0.6.0',
  snapshotLoaded: true,
  snapshotSignature: SNAPSHOT.signature,
};

describe('merge-ready watch UI launcher', () => {
  it('maps browser-open commands per platform', () => {
    expect(createMergeReadyWatchUiOpenCommand('http://127.0.0.1:3000', 'darwin')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:3000'],
    });
    expect(createMergeReadyWatchUiOpenCommand('http://127.0.0.1:3000', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:3000'],
    });
    expect(createMergeReadyWatchUiOpenCommand('http://127.0.0.1:3000', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:3000'],
    });
  });

  it('resolves parent agent dir from the current session dir', () => {
    expect(
      resolveMergeReadyWatchUiAgentDir({ sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--' }),
    ).toBe('/Users/me/.pi/agent-or');
    expect(
      resolveMergeReadyWatchUiAgentDir({ sessionDir: '/tmp/custom-sessions' }),
    ).toBeUndefined();
  });

  it('resolves package root and supervisor entry from both source and dist paths', () => {
    expect(
      resolveMergeReadyWatchUiPackageRoot(
        'file:///repo/packages/pi-merge-ready/extensions/merge-ready/watch-ui/launcher.ts',
      ),
    ).toBe('/repo/packages/pi-merge-ready');
    expect(
      resolveMergeReadyWatchUiPackageRoot(
        'file:///repo/packages/pi-merge-ready/dist/extensions/merge-ready/watch-ui/launcher.js',
      ),
    ).toBe('/repo/packages/pi-merge-ready');
    expect(
      resolveMergeReadyWatchUiSupervisorMainPath(
        'file:///repo/packages/pi-merge-ready/dist/extensions/merge-ready/watch-ui/launcher.js',
      ),
    ).toBe('/repo/packages/pi-merge-ready/dist/extensions/merge-ready/watch-ui/supervisor-main.js');
  });

  it('builds watch-ui URLs with only the bootstrap token', () => {
    expect(createMergeReadyWatchUiUrl(43123, 'token-123')).toBe(
      'http://127.0.0.1:43123/#token=token-123',
    );
  });

  it('captures the parent runtime and passes the runtime snapshot handoff to a new supervisor', async () => {
    const captureRuntimeSnapshot = vi.fn(async () => SNAPSHOT);
    const spawnSupervisor = vi.fn(async () => undefined);
    const removeRuntimeSnapshotHandoff = vi.fn(async () => undefined);
    const getPaths = vi.fn(() => PATHS);
    const readSupervisorInfo = vi
      .fn(async (_paths: unknown): Promise<MergeReadyWatchSupervisorInfo | null> => SUPERVISOR_INFO)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(SUPERVISOR_INFO);

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        getThinkingLevel: () => 'high',
        model: MODEL,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(),
        },
        openBrowser: false,
        sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--',
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        captureRuntimeSnapshot,
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: vi.fn(
          async (_port: number, _options?: { signal?: AbortSignal }) => SUPERVISOR_HEALTH,
        ),
        getPaths,
        openBrowser: vi.fn(async () => ({ opened: true as const })),
        readSupervisorInfo,
        readToken: vi.fn(async () => 'token-123'),
        removeRuntimeSnapshotHandoff,
        removeSupervisorInfo: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor,
        stopSupervisor: vi.fn(async () => undefined),
        writeRuntimeSnapshotHandoff: vi.fn(async () => '/tmp/runtime-snapshot.json'),
      },
    );

    expect(captureRuntimeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: '/Users/me/.pi/agent-or',
        defaultCwd: '/repo',
        model: MODEL,
      }),
    );
    expect(getPaths).toHaveBeenCalledWith('/Users/me/.pi/agent-or');
    expect(spawnSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: '/Users/me/.pi/agent-or',
        defaultCwd: '/repo',
        runtimeSnapshotPath: '/tmp/runtime-snapshot.json',
      }),
    );
    expect(removeRuntimeSnapshotHandoff).not.toHaveBeenCalled();
    expect(result).toEqual({
      level: 'info',
      message: 'Merge-ready watch UI launched: http://127.0.0.1:43123/#token=token-123',
    });
  });

  it('rejects unresolved auth placeholders before spawning the supervisor', async () => {
    const spawnSupervisor = vi.fn(async () => undefined);

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        getThinkingLevel: () => 'high',
        model: MODEL,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(),
        },
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        captureRuntimeSnapshot: vi.fn(async () => {
          throw new Error(
            'Merge-ready watch UI runtime preflight failed: unresolved apiKey placeholder "$PI_PROXY_API_KEY".',
          );
        }),
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: vi.fn(async () => null),
        getPaths: vi.fn(() => PATHS),
        openBrowser: vi.fn(async () => ({ opened: true as const })),
        readSupervisorInfo: vi.fn(async () => null),
        readToken: vi.fn(async () => 'token-123'),
        removeRuntimeSnapshotHandoff: vi.fn(async () => undefined),
        removeSupervisorInfo: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor,
        stopSupervisor: vi.fn(async () => undefined),
        writeRuntimeSnapshotHandoff: vi.fn(async () => '/tmp/runtime-snapshot.json'),
      },
    );

    expect(spawnSupervisor).not.toHaveBeenCalled();
    expect(result.level).toBe('error');
    expect(result.message).toContain('$PI_PROXY_API_KEY');
  });

  it('reuses a healthy supervisor only when the runtime signature matches', async () => {
    const spawnSupervisor = vi.fn();
    const openBrowser = vi.fn(async () => ({
      opened: false as const,
      message: 'no browser command',
    }));

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        getThinkingLevel: () => 'high',
        model: MODEL,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(),
        },
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        captureRuntimeSnapshot: vi.fn(async () => SNAPSHOT),
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: vi.fn(
          async (_port: number, _options?: { signal?: AbortSignal }) => SUPERVISOR_HEALTH,
        ),
        getPaths: vi.fn(() => PATHS),
        openBrowser,
        readSupervisorInfo: vi.fn(async (_paths: unknown) => SUPERVISOR_INFO),
        readToken: vi.fn(async () => 'token-123'),
        removeRuntimeSnapshotHandoff: vi.fn(async () => undefined),
        removeSupervisorInfo: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor,
        stopSupervisor: vi.fn(async () => undefined),
        writeRuntimeSnapshotHandoff: vi.fn(async () => '/tmp/runtime-snapshot.json'),
      },
    );

    expect(spawnSupervisor).not.toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('Merge-ready watch UI is already running');
    expect(result.message).toContain('Visit http://127.0.0.1:43123/#token=token-123');
  });

  it('restarts a healthy supervisor when the runtime signature changes', async () => {
    const oldInfo = {
      ...SUPERVISOR_INFO,
      snapshotSignature: 'runtime-signature-old',
    };
    const oldHealth = {
      ...SUPERVISOR_HEALTH,
      snapshotSignature: 'runtime-signature-old',
    };

    const stopSupervisor = vi.fn(async () => undefined);
    const spawnSupervisor = vi.fn(async () => undefined);

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        getThinkingLevel: () => 'high',
        model: MODEL,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(),
        },
        openBrowser: false,
        sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--',
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        captureRuntimeSnapshot: vi.fn(async () => SNAPSHOT),
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: vi
          .fn()
          .mockResolvedValueOnce(oldHealth)
          .mockResolvedValueOnce(oldHealth)
          .mockResolvedValueOnce(SUPERVISOR_HEALTH),
        getPaths: vi.fn(() => PATHS),
        openBrowser: vi.fn(async () => ({ opened: true as const })),
        readSupervisorInfo: vi
          .fn()
          .mockResolvedValueOnce(oldInfo)
          .mockResolvedValueOnce(oldInfo)
          .mockResolvedValueOnce(SUPERVISOR_INFO),
        readToken: vi.fn(async () => 'token-123'),
        removeRuntimeSnapshotHandoff: vi.fn(async () => undefined),
        removeSupervisorInfo: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor,
        stopSupervisor,
        writeRuntimeSnapshotHandoff: vi.fn(async () => '/tmp/runtime-snapshot.json'),
      },
    );

    expect(stopSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        info: expect.objectContaining({ snapshotSignature: 'runtime-signature-old' }),
      }),
    );
    expect(spawnSupervisor).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      level: 'info',
      message: 'Merge-ready watch UI launched: http://127.0.0.1:43123/#token=token-123',
    });
  });

  it('cleans up the private runtime snapshot handoff when startup fails', async () => {
    const removeRuntimeSnapshotHandoff = vi.fn(async () => undefined);

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        getThinkingLevel: () => 'high',
        model: MODEL,
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn(),
        },
        openBrowser: false,
        startupTimeoutMs: 1,
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        captureRuntimeSnapshot: vi.fn(async () => SNAPSHOT),
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: vi.fn(async () => null),
        getPaths: vi.fn(() => PATHS),
        openBrowser: vi.fn(async () => ({ opened: true as const })),
        readSupervisorInfo: vi.fn(async () => null),
        readToken: vi.fn(async () => 'token-123'),
        removeRuntimeSnapshotHandoff,
        removeSupervisorInfo: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor: vi.fn(async () => undefined),
        stopSupervisor: vi.fn(async () => undefined),
        writeRuntimeSnapshotHandoff: vi.fn(async () => '/tmp/runtime-snapshot.json'),
      },
    );

    expect(removeRuntimeSnapshotHandoff).toHaveBeenCalledWith('/tmp/runtime-snapshot.json');
    expect(result.level).toBe('error');
    expect(result.message).toContain('runtime signature');
  });

  it('stops a healthy supervisor for the current session agent', async () => {
    const stopSupervisor = vi.fn(async () => undefined);
    const removeSupervisorInfo = vi.fn(async () => undefined);
    const getPaths = vi.fn(() => PATHS);
    const fetchHealth = vi.fn(async () => SUPERVISOR_HEALTH);
    const sleep = vi.fn(async () => undefined);

    const result = await stopMergeReadyWatchUIWithDependencies(
      {
        sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--',
      },
      {
        fetchHealth,
        getPaths,
        readSupervisorInfo: vi.fn(async () => SUPERVISOR_INFO),
        removeSupervisorInfo,
        sleep,
        stopSupervisor,
      },
    );

    expect(getPaths).toHaveBeenCalledWith('/Users/me/.pi/agent-or');
    expect(stopSupervisor).toHaveBeenCalledWith({
      info: SUPERVISOR_INFO,
      fetchHealth,
      sleep,
    });
    expect(removeSupervisorInfo).toHaveBeenCalledWith(PATHS);
    expect(result).toEqual({
      level: 'info',
      message: 'Stopped merge-ready watch UI.',
    });
  });

  it('reports when watch-ui is not running', async () => {
    const stopSupervisor = vi.fn(async () => undefined);

    const result = await stopMergeReadyWatchUIWithDependencies(
      {},
      {
        fetchHealth: vi.fn(async () => SUPERVISOR_HEALTH),
        getPaths: vi.fn(() => PATHS),
        readSupervisorInfo: vi.fn(async () => null),
        removeSupervisorInfo: vi.fn(async () => undefined),
        sleep: vi.fn(async () => undefined),
        stopSupervisor,
      },
    );

    expect(stopSupervisor).not.toHaveBeenCalled();
    expect(result).toEqual({
      level: 'info',
      message: 'Merge-ready watch UI is not running.',
    });
  });

  it('clears stale supervisor state when health probing fails', async () => {
    const removeSupervisorInfo = vi.fn(async () => undefined);
    const stopSupervisor = vi.fn(async () => undefined);

    const result = await stopMergeReadyWatchUIWithDependencies(
      {},
      {
        fetchHealth: vi.fn(async () => null),
        getPaths: vi.fn(() => PATHS),
        readSupervisorInfo: vi.fn(async () => SUPERVISOR_INFO),
        removeSupervisorInfo,
        sleep: vi.fn(async () => undefined),
        stopSupervisor,
      },
    );

    expect(stopSupervisor).not.toHaveBeenCalled();
    expect(removeSupervisorInfo).toHaveBeenCalledWith(PATHS);
    expect(result).toEqual({
      level: 'warning',
      message: 'Merge-ready watch UI is not responding. Cleared stale supervisor state.',
    });
  });
});
