import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateSessionDeckDesktopAppBundle } from '../../extensions/session-deck/desktop/bundle.js';
import { doctorSessionDeckDesktopInstall } from '../../extensions/session-deck/desktop/doctor.js';
import { openSessionDeckDesktop } from '../../extensions/session-deck/desktop/open.js';
import {
  getDefaultSessionDeckDesktopAppPath,
  getSessionDeckDesktopCacheDir,
  getSessionDeckDesktopStatePath,
  getSessionDeckDesktopTmpDir,
  type SessionDeckDesktopRuntimePaths,
} from '../../extensions/session-deck/desktop/paths.js';
import {
  hashSessionDeckDesktopPath,
  writeSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from '../../extensions/session-deck/desktop/state.js';
import { uninstallSessionDeckDesktop } from '../../extensions/session-deck/desktop/uninstall.js';

const NOW = '2026-07-17T00:00:00.000Z';

async function createFakeApp(
  path: string,
  version = '0.9.0',
  executableName: string | null = 'session-deck-desktop',
): Promise<void> {
  await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
  const executableDeclaration =
    executableName === null
      ? ''
      : `  <key>CFBundleExecutable</key>\n  <string>${executableName}</string>\n`;
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
${executableDeclaration}</dict>
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

  it.each([
    {
      name: 'missing declaration',
      declaration: null,
      form: 'unchanged',
      error: 'missing CFBundleExecutable',
    },
    {
      name: 'unsafe declaration',
      declaration: '../outside',
      form: 'unchanged',
      error: 'unsafe CFBundleExecutable',
    },
    {
      name: 'wrong declaration',
      declaration: 'not-the-executable',
      form: 'unchanged',
      error: 'declared executable is missing',
    },
    {
      name: 'symlink declaration',
      declaration: 'linked-executable',
      form: 'symlink',
      error: 'declared executable must not be a symlink',
    },
    {
      name: 'directory declaration',
      declaration: 'executable-directory',
      form: 'directory',
      error: 'declared executable is not a regular file',
    },
    {
      name: 'empty declaration target',
      declaration: 'empty-executable',
      form: 'empty',
      error: 'declared executable is empty',
    },
    {
      name: 'non-executable declaration target',
      declaration: 'session-deck-desktop',
      form: 'non-executable',
      error: 'declared executable is not executable',
    },
  ])('rejects a $name', async ({ declaration, form, error }) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-bundle-'));
    const appPath = join(root, 'Session Deck Desktop.app');
    const macosPath = join(appPath, 'Contents', 'MacOS');
    await createFakeApp(appPath, '0.9.0', declaration);

    if (form === 'symlink') {
      await symlink('session-deck-desktop', join(macosPath, declaration!));
    } else if (form === 'directory') {
      await mkdir(join(macosPath, declaration!));
    } else if (form === 'empty') {
      await writeFile(join(macosPath, declaration!), '', { mode: 0o755 });
    } else if (form === 'non-executable') {
      await chmod(join(macosPath, declaration!), 0o644);
    }

    await expect(validateSessionDeckDesktopAppBundle(appPath)).rejects.toThrow(error);
  });

  it('reports a declared executable that loses execute permission in doctor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-doctor-'));
    const home = join(root, 'home');
    const appPath = getDefaultSessionDeckDesktopAppPath(home);
    const executablePath = join(appPath, 'Contents', 'MacOS', 'session-deck-desktop');
    await createFakeApp(appPath);
    await writeState(home, root);
    await chmod(executablePath, 0o644);

    const result = await doctorSessionDeckDesktopInstall({
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result.level).toBe('warning');
    expect(result.message).toContain(
      `Installed app bundle is invalid: App bundle declared executable is not executable: ${executablePath}`,
    );
    expect(result.message).not.toContain('Installed app checksum differs from recorded state.');
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

  it('stops after the first owned-path removal failure and completes on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-uninstall-'));
    const home = join(root, 'home');
    const appPath = getDefaultSessionDeckDesktopAppPath(home);
    const failedPath = join(getSessionDeckDesktopCacheDir(home), 'failed-cache');
    const pendingPath = join(getSessionDeckDesktopTmpDir(home), 'pending-tmp');
    const outsidePath = join(root, 'do-not-remove.txt');
    await createFakeApp(appPath);
    await mkdir(failedPath, { recursive: true });
    await mkdir(pendingPath, { recursive: true });
    await writeFile(outsidePath, 'keep');
    await writeState(home, root, {
      ownedPaths: [appPath, failedPath, pendingPath, outsidePath],
    });
    const attemptedPaths: string[] = [];
    const removePath: typeof rm = async (path, options) => {
      attemptedPaths.push(String(path));
      if (String(path) === failedPath) {
        throw new Error('simulated removal failure');
      }
      await rm(path, options);
    };

    const firstResult = await uninstallSessionDeckDesktop({ homeDirectory: home, removePath });

    expect(firstResult.level).toBe('warning');
    expect(firstResult.message).toContain(`Removed owned paths:\n- ${appPath}`);
    expect(firstResult.message).toContain(
      `Failed owned path:\n- ${failedPath}: simulated removal failure`,
    );
    expect(firstResult.message).toContain(`Pending owned paths:\n- ${pendingPath}`);
    expect(firstResult.message).toContain(
      `Install state retained for retry: ${getSessionDeckDesktopStatePath(home)}`,
    );
    expect(firstResult.message).toContain(`Skipped unsafe ownedPaths entries:\n- ${outsidePath}`);
    expect(attemptedPaths).toEqual([appPath, failedPath]);
    await expect(lstat(appPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(failedPath)).resolves.toMatchObject({});
    await expect(lstat(pendingPath)).resolves.toMatchObject({});
    await expect(lstat(getSessionDeckDesktopStatePath(home))).resolves.toMatchObject({});
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('keep');

    const retryResult = await uninstallSessionDeckDesktop({ homeDirectory: home });

    expect(retryResult.level).toBe('warning');
    await expect(lstat(failedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(getSessionDeckDesktopStatePath(home))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('keep');
  });

  it('warns truthfully when only install state removal fails and completes on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-uninstall-'));
    const home = join(root, 'home');
    const appPath = getDefaultSessionDeckDesktopAppPath(home);
    const statePath = getSessionDeckDesktopStatePath(home);
    await createFakeApp(appPath);
    await writeState(home, root);
    const removePath: typeof rm = async (path, options) => {
      if (String(path) === statePath) {
        throw new Error('simulated state removal failure');
      }
      await rm(path, options);
    };

    const firstResult = await uninstallSessionDeckDesktop({ homeDirectory: home, removePath });

    expect(firstResult.level).toBe('warning');
    expect(firstResult.message).toContain(
      'Session Deck desktop safe owned-path cleanup completed, but install state removal failed.',
    );
    expect(firstResult.message).toContain(`Removed owned paths:\n- ${appPath}`);
    expect(firstResult.message).toContain(
      `Failed state path:\n- ${statePath}: simulated state removal failure`,
    );
    expect(firstResult.message).toContain('Pending owned paths:\n- (none)');
    await expect(lstat(appPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(statePath)).resolves.toMatchObject({});

    const retryResult = await uninstallSessionDeckDesktop({ homeDirectory: home });

    expect(retryResult.level).toBe('info');
    await expect(lstat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
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
