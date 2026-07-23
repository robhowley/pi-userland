import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { doctorSessionDeckDesktopInstall } from '../../extensions/session-deck/desktop/doctor.js';
import { openSessionDeckDesktop } from '../../extensions/session-deck/desktop/open.js';
import {
  getDefaultSessionDeckDesktopAppPath,
  getSessionDeckDesktopStatePath,
  type SessionDeckDesktopRuntimePaths,
} from '../../extensions/session-deck/desktop/paths.js';
import {
  hashSessionDeckDesktopPath,
  writeSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from '../../extensions/session-deck/desktop/state.js';
import { uninstallSessionDeckDesktop } from '../../extensions/session-deck/desktop/uninstall.js';

const NOW = '2026-07-17T00:00:00.000Z';

async function createFakeApp(path: string, version = '0.9.0'): Promise<void> {
  await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(
    join(path, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.pi-userland.session-deck.desktop</string>
  <key>CFBundleName</key>
  <string>Session Deck Desktop</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`,
  );
  await writeFile(join(path, 'Contents', 'MacOS', 'session-deck-desktop'), 'binary', {
    mode: 0o755,
  });
}

function runtimePaths(root: string): SessionDeckDesktopRuntimePaths {
  return {
    packageRoot: root,
    packageVersion: '0.9.0',
    nodeExecutablePath: process.execPath,
  };
}

async function writeState(
  home: string,
  root: string,
  overrides: Partial<SessionDeckDesktopInstallState> = {},
): Promise<SessionDeckDesktopInstallState> {
  const appPath = getDefaultSessionDeckDesktopAppPath(home);
  const state: SessionDeckDesktopInstallState = {
    schemaVersion: 1,
    product: 'session-deck-desktop',
    packageName: '@robhowley/pi-session-deck',
    packageVersion: '0.9.0',
    installedAt: NOW,
    app: {
      path: appPath,
      bundleIdentifier: 'dev.pi-userland.session-deck.desktop',
      name: 'Session Deck Desktop',
      version: '0.9.0',
      sha256: await hashSessionDeckDesktopPath(appPath),
    },
    source: {
      kind: 'local-path',
      path: appPath,
      sha256: await hashSessionDeckDesktopPath(appPath),
    },
    runtime: {
      nodeExecutablePath: process.execPath,
      packageRoot: root,
      helperPackageVersion: '0.9.0',
    },
    ownedPaths: [appPath],
    ...overrides,
  };
  await writeSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home), state);
  return state;
}

describe('session-deck desktop open, doctor, and uninstall', () => {
  it('opens the installed app through /usr/bin/open argv without shell interpolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-open-'));
    const home = join(root, 'home');
    const appPath = getDefaultSessionDeckDesktopAppPath(home);
    await createFakeApp(appPath);
    await writeState(home, root);
    const execFile = vi.fn(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const result = await openSessionDeckDesktop({
      execFile,
      homeDirectory: home,
      platform: 'darwin',
    });

    expect(result).toEqual({
      level: 'info',
      message: `Opened Session Deck desktop app: ${appPath}`,
    });
    expect(execFile).toHaveBeenCalledWith('/usr/bin/open', [appPath], expect.any(Function));
  });

  it('reports missing install state in doctor without mutating anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-doctor-'));
    const home = join(root, 'home');

    const result = await doctorSessionDeckDesktopInstall({
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result.level).toBe('warning');
    expect(result.message).toContain('Session Deck desktop doctor');
    expect(result.message).toContain(
      `Install state not found at ${getSessionDeckDesktopStatePath(home)}`,
    );
  });

  it('reports a valid install as healthy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-doctor-'));
    const home = join(root, 'home');
    await createFakeApp(getDefaultSessionDeckDesktopAppPath(home));
    await writeState(home, root);

    const result = await doctorSessionDeckDesktopInstall({
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result.level).toBe('info');
    expect(result.message).toContain('Session Deck desktop doctor');
    expect(result.message).not.toContain('Issues:');
  });

  it('uninstalls only safe owned paths and leaves unsafe ownedPaths entries untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-uninstall-'));
    const home = join(root, 'home');
    const appPath = getDefaultSessionDeckDesktopAppPath(home);
    const outsidePath = join(root, 'do-not-remove.txt');
    await createFakeApp(appPath);
    await writeFile(outsidePath, 'keep');
    await writeState(home, root, { ownedPaths: [appPath, outsidePath] });

    const result = await uninstallSessionDeckDesktop({ homeDirectory: home });

    expect(result.level).toBe('warning');
    expect(result.message).toContain('Skipped unsafe ownedPaths entries:');
    await expect(lstat(appPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(getSessionDeckDesktopStatePath(home))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('keep');
  });

  it('does not remove the app when uninstall metadata is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-uninstall-'));
    const home = join(root, 'home');
    const appPath = getDefaultSessionDeckDesktopAppPath(home);
    await createFakeApp(appPath);
    await mkdir(join(home, '.pi', 'session-deck', 'desktop'), { recursive: true });
    await writeFile(getSessionDeckDesktopStatePath(home), '{"not":"valid"}\n');

    const result = await uninstallSessionDeckDesktop({ homeDirectory: home });

    expect(result.level).toBe('warning');
    expect(result.message).toContain(
      'Nothing was removed because app ownership could not be verified.',
    );
    await expect(lstat(appPath)).resolves.toMatchObject({});
  });
});
