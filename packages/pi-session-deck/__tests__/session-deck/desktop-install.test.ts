import { lstat, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installSessionDeckDesktop } from '../../extensions/session-deck/desktop/install.js';
import {
  getDefaultSessionDeckDesktopAppPath,
  getSessionDeckDesktopStatePath,
  type SessionDeckDesktopRuntimePaths,
} from '../../extensions/session-deck/desktop/paths.js';
import {
  hashSessionDeckDesktopPath,
  readSessionDeckDesktopInstallState,
} from '../../extensions/session-deck/desktop/state.js';

const NOW = new Date('2026-07-17T00:00:00.000Z');

async function createFakeApp(path: string, version: string, marker: string): Promise<void> {
  await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(
    join(path, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.pi-userland.session-deck.desktop</string>
  <key>CFBundleDisplayName</key>
  <string>Session Deck Desktop</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`,
  );
  await writeFile(join(path, 'Contents', 'MacOS', 'session-deck-desktop'), marker, {
    mode: 0o755,
  });
}

function runtimePaths(root: string, version = '0.9.0'): SessionDeckDesktopRuntimePaths {
  return {
    packageRoot: root,
    packageVersion: version,
    nodeExecutablePath: process.execPath,
  };
}

describe('session-deck desktop install', () => {
  it('installs from a local fake .app and writes desktop metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const sourceApp = join(root, 'Session Deck Desktop.app');
    await createFakeApp(sourceApp, '0.9.0', 'v1');

    const result = await installSessionDeckDesktop({
      fromPath: sourceApp,
      homeDirectory: home,
      now: () => NOW,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    const targetApp = getDefaultSessionDeckDesktopAppPath(home);
    await expect(lstat(targetApp)).resolves.toMatchObject({});
    await expect(
      readFile(join(targetApp, 'Contents', 'MacOS', 'session-deck-desktop'), 'utf8'),
    ).resolves.toBe('v1');
    const state = await readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home));
    expect(result.level).toBe('info');
    expect(result.message).toContain('Installed Session Deck desktop app.');
    expect(state).toMatchObject({
      installedAt: NOW.toISOString(),
      app: {
        path: targetApp,
        bundleIdentifier: 'dev.pi-userland.session-deck.desktop',
        name: 'Session Deck Desktop',
        version: '0.9.0',
      },
      source: {
        kind: 'local-path',
        path: resolve(sourceApp),
        sha256: await hashSessionDeckDesktopPath(sourceApp),
      },
      runtime: {
        packageRoot: root,
        helperPackageVersion: '0.9.0',
      },
      ownedPaths: [targetApp],
    });
  });

  it('fails checksum verification without writing app or state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const sourceApp = join(root, 'Session Deck Desktop.app');
    await createFakeApp(sourceApp, '0.9.0', 'v1');

    const result = await installSessionDeckDesktop({
      fromPath: sourceApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
      sha256: '0'.repeat(64),
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain('Checksum mismatch');
    await expect(lstat(getDefaultSessionDeckDesktopAppPath(home))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home)),
    ).resolves.toBeNull();
  });

  it('restores the previous app when metadata write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const firstApp = join(root, 'first', 'Session Deck Desktop.app');
    const secondApp = join(root, 'second', 'Session Deck Desktop.app');
    await createFakeApp(firstApp, '0.9.0', 'v1');
    await createFakeApp(secondApp, '0.10.0', 'v2');

    await expect(
      installSessionDeckDesktop({
        fromPath: firstApp,
        homeDirectory: home,
        now: () => NOW,
        platform: 'darwin',
        runtimePaths: runtimePaths(root),
      }),
    ).resolves.toMatchObject({ level: 'info' });

    const targetExecutable = join(
      getDefaultSessionDeckDesktopAppPath(home),
      'Contents',
      'MacOS',
      'session-deck-desktop',
    );
    const result = await installSessionDeckDesktop({
      fromPath: secondApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root, '0.10.0'),
      writeInstallState: async () => {
        throw new Error('state disk full');
      },
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain('Previous app install was restored.');
    await expect(readFile(targetExecutable, 'utf8')).resolves.toBe('v1');
    await expect(
      readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home)),
    ).resolves.toMatchObject({
      app: { version: '0.9.0' },
    });
  });
});
