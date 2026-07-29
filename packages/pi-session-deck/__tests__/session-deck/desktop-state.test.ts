import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSessionDeckDesktopInstallState,
  readSessionDeckDesktopInstallState,
  writeSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from '../../extensions/session-deck/desktop/state.js';
import {
  SESSION_DECK_ITERM2_CREATE_WORKTREE_HELPER_RELATIVE_PATH,
  SESSION_DECK_ITERM2_HELPER_RELATIVE_PATH,
  SESSION_DECK_ITERM2_KILL_HELPER_RELATIVE_PATH,
  SESSION_DECK_ITERM2_OPEN_HELPER_RELATIVE_PATH,
  SESSION_DECK_ITERM2_WEB_ROOT_RELATIVE_PATH,
} from '../../extensions/session-deck/iterm2/paths.js';

const SHA256 = 'b'.repeat(64);

function buildState(
  overrides: Partial<SessionDeckDesktopInstallState> = {},
): SessionDeckDesktopInstallState {
  const appPath = '/Users/test/Applications/Session Deck Desktop.app';
  return {
    schemaVersion: 1,
    product: 'session-deck-desktop',
    packageName: '@robhowley/pi-session-deck',
    packageVersion: '0.9.0',
    installedAt: '2026-07-17T00:00:00.000Z',
    app: {
      path: appPath,
      bundleIdentifier: 'dev.pi-userland.session-deck.desktop',
      name: 'Session Deck Desktop',
      version: '0.9.0',
      sha256: SHA256,
    },
    source: {
      kind: 'local-path',
      path: '/tmp/Session Deck Desktop.app',
      sha256: SHA256,
    },
    runtime: {
      nodeExecutablePath: '/usr/local/bin/node',
      packageRoot: '/tmp/pi-session-deck',
      helperPackageVersion: '0.9.0',
    },
    ownedPaths: [appPath],
    ...overrides,
  };
}

describe('session-deck desktop state', () => {
  it('round-trips install state atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-state-'));
    const statePath = join(root, 'desktop', 'install.json');
    const state = buildState();

    await writeSessionDeckDesktopInstallState(statePath, state);
    await chmod(statePath, 0o644);
    await writeSessionDeckDesktopInstallState(statePath, state);

    await expect(readSessionDeckDesktopInstallState(statePath)).resolves.toEqual(state);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it('returns null for missing state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-state-'));
    await expect(
      readSessionDeckDesktopInstallState(join(root, 'missing.json')),
    ).resolves.toBeNull();
  });

  it('rejects invalid schema and unowned app path', () => {
    expect(() =>
      parseSessionDeckDesktopInstallState({ ...buildState(), schemaVersion: 2 }),
    ).toThrow('State has an invalid shape.');
    expect(() =>
      parseSessionDeckDesktopInstallState({ ...buildState(), ownedPaths: ['/tmp/other'] }),
    ).toThrow('State does not record the app path as owned.');
  });

  it('parses GitHub release source state', () => {
    const state = buildState({
      source: {
        kind: 'github-release',
        releaseTag: 'pi-session-deck-v0.9.0',
        assetName: 'session-deck-desktop-v0.9.0-macos-arm64.zip',
        url: 'https://example.test/asset.zip',
        sha256: SHA256,
      },
    });

    expect(parseSessionDeckDesktopInstallState(state).source).toEqual(state.source);
  });

  it('matches the shared desktop runtime layout without persisting derived helper paths', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../../apps/session-deck-desktop/fixtures/runtime-layout-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      schemaVersion: number;
      snapshotHelperRelativePath: string;
      openActionHelperRelativePath: string;
      killActionHelperRelativePath: string;
      worktreeActionHelperRelativePath: string;
      webRootRelativePath: string;
    };
    const relativeLayout = {
      schemaVersion: 1,
      snapshotHelperRelativePath: SESSION_DECK_ITERM2_HELPER_RELATIVE_PATH,
      openActionHelperRelativePath: SESSION_DECK_ITERM2_OPEN_HELPER_RELATIVE_PATH,
      killActionHelperRelativePath: SESSION_DECK_ITERM2_KILL_HELPER_RELATIVE_PATH,
      worktreeActionHelperRelativePath: SESSION_DECK_ITERM2_CREATE_WORKTREE_HELPER_RELATIVE_PATH,
      webRootRelativePath: SESSION_DECK_ITERM2_WEB_ROOT_RELATIVE_PATH,
    };
    expect(relativeLayout).toEqual(fixture);

    const state = parseSessionDeckDesktopInstallState(buildState());
    expect({
      snapshotHelperPath: join(
        state.runtime.packageRoot,
        relativeLayout.snapshotHelperRelativePath,
      ),
      openActionHelperPath: join(
        state.runtime.packageRoot,
        relativeLayout.openActionHelperRelativePath,
      ),
      killActionHelperPath: join(
        state.runtime.packageRoot,
        relativeLayout.killActionHelperRelativePath,
      ),
      worktreeActionHelperPath: join(
        state.runtime.packageRoot,
        relativeLayout.worktreeActionHelperRelativePath,
      ),
      webRootPath: join(state.runtime.packageRoot, relativeLayout.webRootRelativePath),
    }).toEqual({
      snapshotHelperPath:
        '/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/snapshot-cli.js',
      openActionHelperPath:
        '/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/open-action-cli.js',
      killActionHelperPath:
        '/tmp/pi-session-deck/dist/extensions/session-deck/iterm2/kill-action-cli.js',
      worktreeActionHelperPath:
        '/tmp/pi-session-deck/dist/extensions/session-deck/worktree/action-cli.js',
      webRootPath: '/tmp/pi-session-deck/extensions/session-deck/iterm2/web',
    });
    expect(Object.keys(state.runtime).sort()).toEqual([
      'helperPackageVersion',
      'nodeExecutablePath',
      'packageRoot',
    ]);
  });
});
