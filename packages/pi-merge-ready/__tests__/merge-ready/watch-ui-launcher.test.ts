import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => undefined),
}));
import {
  createMergeReadyWatchUiOpenCommand,
  launchMergeReadyWatchUIWithDependencies,
  resolveMergeReadyWatchUiAgentDir,
  resolveMergeReadyWatchUiPackageRoot,
  resolveMergeReadyWatchUiSupervisorMainPath,
} from '../../extensions/merge-ready/watch-ui/launcher.js';
import { MERGE_READY_WATCH_UI_SERVICE } from '../../extensions/merge-ready/watch-ui/supervisor-state.js';

const PATHS = {
  stateDir: '/tmp/merge-ready/watch-ui',
  supervisorInfoFile: '/tmp/merge-ready/watch-ui/supervisor.json',
  tokenFile: '/tmp/merge-ready/watch-ui/token',
  watchesFile: '/tmp/merge-ready/watch-ui/watches.json',
  logFile: '/tmp/merge-ready/watch-ui/supervisor.log',
  startupLockDir: '/tmp/merge-ready/watch-ui/startup.lock',
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
    expect(resolveMergeReadyWatchUiAgentDir({ sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--' })).toBe(
      '/Users/me/.pi/agent-or',
    );
    expect(resolveMergeReadyWatchUiAgentDir({ sessionDir: '/tmp/custom-sessions' })).toBeUndefined();
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

  it('passes the parent agent dir through when launching a new supervisor', async () => {
    const spawnSupervisor = vi.fn(async () => undefined);
    const getPaths = vi.fn(() => PATHS);
    const readSupervisorInfo = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        service: MERGE_READY_WATCH_UI_SERVICE,
        pid: 42,
        port: 43123,
        startedAt: '2026-06-08T12:00:00.000Z',
        packageVersion: '0.6.0',
        tokenFile: PATHS.tokenFile,
        defaultCwd: '/repo',
        extensionDir: '/pkg/dist/extensions/merge-ready',
        extensionEntryPath: '/pkg/dist/extensions/merge-ready/index.js',
      });

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
        sessionDir: '/Users/me/.pi/agent-or/sessions/--repo--',
        openBrowser: false,
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: async (_port: number, _options?: { signal?: AbortSignal }) => ({
          service: MERGE_READY_WATCH_UI_SERVICE,
          pid: 42,
          port: 43123,
          startedAt: '2026-06-08T12:00:00.000Z',
          packageVersion: '0.6.0',
        }),
        getPaths,
        openBrowser: vi.fn(async () => ({ opened: true as const })),
        readSupervisorInfo,
        readToken: vi.fn(async () => 'token-123'),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor,
      },
    );

    expect(getPaths).toHaveBeenCalledWith('/Users/me/.pi/agent-or');
    expect(spawnSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: '/Users/me/.pi/agent-or', defaultCwd: '/repo' }),
    );
    expect(result).toEqual({
      level: 'info',
      message: 'Merge-ready watch UI launched: http://127.0.0.1:43123/#token=token-123&cwd=%2Frepo',
    });
  });

  it('reuses a healthy supervisor and reports the URL when browser open fails', async () => {
    const spawnSupervisor = vi.fn();
    const openBrowser = vi.fn(async () => ({
      opened: false as const,
      message: 'no browser command',
    }));

    const result = await launchMergeReadyWatchUIWithDependencies(
      {
        cwd: '/repo',
        exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
      },
      {
        acquireStartupLock: vi.fn(async () => async () => undefined),
        ensureToken: vi.fn(async () => 'token-123'),
        fetchHealth: async (_port: number, _options?: { signal?: AbortSignal }) => ({
          service: MERGE_READY_WATCH_UI_SERVICE,
          pid: 42,
          port: 43123,
          startedAt: '2026-06-08T12:00:00.000Z',
          packageVersion: '0.6.0',
        }),
        getPaths: vi.fn(() => PATHS),
        openBrowser,
        readSupervisorInfo: async (_paths) => ({
          service: MERGE_READY_WATCH_UI_SERVICE,
          pid: 42,
          port: 43123,
          startedAt: '2026-06-08T12:00:00.000Z',
          packageVersion: '0.6.0',
          tokenFile: PATHS.tokenFile,
          defaultCwd: '/repo',
          extensionDir: '/pkg/dist/extensions/merge-ready',
          extensionEntryPath: '/pkg/dist/extensions/merge-ready/index.js',
        }),
        readToken: vi.fn(async () => 'token-123'),
        sleep: vi.fn(async () => undefined),
        spawnSupervisor,
      },
    );

    expect(spawnSupervisor).not.toHaveBeenCalled();
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('warning');
    expect(result.message).toContain('Merge-ready watch UI is already running');
    expect(result.message).toContain('Visit http://127.0.0.1:43123/#token=token-123&cwd=%2Frepo');
  });
});
