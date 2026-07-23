import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSessionDeckDesktopInstallState,
  readSessionDeckDesktopInstallState,
  writeSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from '../../extensions/session-deck/desktop/state.js';

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

    await expect(readSessionDeckDesktopInstallState(statePath)).resolves.toEqual(state);
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
});
