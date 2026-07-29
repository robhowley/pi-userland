import { rename, readdir, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installSessionDeckDesktop,
  type SessionDeckDesktopExecFile,
} from '../../extensions/session-deck/desktop/install.js';
import type { SessionDeckDesktopFetch } from '../../extensions/session-deck/desktop/artifact.js';
import {
  getDefaultSessionDeckDesktopAppPath,
  getSessionDeckDesktopArtifactName,
  getSessionDeckDesktopReleaseTag,
  getSessionDeckDesktopStatePath,
  type SessionDeckDesktopRuntimePaths,
} from '../../extensions/session-deck/desktop/paths.js';
import {
  hashSessionDeckDesktopContent,
  hashSessionDeckDesktopPath,
  readSessionDeckDesktopInstallState,
} from '../../extensions/session-deck/desktop/state.js';

const NOW = new Date('2026-07-17T00:00:00.000Z');
const RELEASE_VERSION = '0.11.1';

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
  <key>CFBundleExecutable</key>
  <string>session-deck-desktop</string>
</dict>
</plist>
`,
  );
  await writeFile(join(path, 'Contents', 'MacOS', 'session-deck-desktop'), marker, {
    mode: 0o755,
  });
}

function runtimePaths(root: string, version = RELEASE_VERSION): SessionDeckDesktopRuntimePaths {
  return {
    packageRoot: root,
    packageVersion: version,
    nodeExecutablePath: process.execPath,
  };
}

function createReleaseFetch(options: {
  arch: 'arm64' | 'x64';
  archive: Buffer;
  version?: string;
}): { fetch: SessionDeckDesktopFetch; assetName: string; requestedUrls: string[] } {
  const version = options.version ?? RELEASE_VERSION;
  const assetName = getSessionDeckDesktopArtifactName(version, {
    arch: options.arch,
    platform: 'darwin',
  });
  const assetUrl = `https://downloads.test/${assetName}`;
  const checksumUrl = `${assetUrl}.sha256`;
  const checksum = hashSessionDeckDesktopContent(options.archive);
  const requestedUrls: string[] = [];
  const fetch: SessionDeckDesktopFetch = async (url) => {
    requestedUrls.push(url);
    if (url.includes('/releases/tags/')) {
      return createFetchResponse({
        json: {
          assets: [
            { name: assetName, browser_download_url: assetUrl },
            { name: `${assetName}.sha256`, browser_download_url: checksumUrl },
          ],
        },
      });
    }
    if (url === checksumUrl) {
      return createFetchResponse({ text: `${checksum}  ${assetName}\n` });
    }
    if (url === assetUrl) {
      return createFetchResponse({ bytes: options.archive });
    }
    return createFetchResponse({ ok: false, status: 404, statusText: 'Not Found' });
  };
  return { fetch, assetName, requestedUrls };
}

function createFetchResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
  bytes?: Buffer;
}) {
  const bytes = options.bytes ?? Buffer.alloc(0);
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => options.json,
    text: async () => options.text ?? '',
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

function createDittoExtractor(version: string, marker: string): SessionDeckDesktopExecFile {
  return (file, args, callback) => {
    void (async () => {
      expect(file).toBe('/usr/bin/ditto');
      expect(args.slice(0, 2)).toEqual(['-x', '-k']);
      await createFakeApp(join(args[3]!, 'Session Deck Desktop.app'), version, marker);
    })().then(
      () => callback(null),
      (error: unknown) => callback(error as Error),
    );
  };
}

async function executableMarker(home: string): Promise<string> {
  return readFile(
    join(getDefaultSessionDeckDesktopAppPath(home), 'Contents', 'MacOS', 'session-deck-desktop'),
    'utf8',
  );
}

describe('session-deck desktop install', () => {
  it('keeps local artifacts with a differing app version and optional checksum valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const sourceApp = join(root, 'Session Deck Desktop.app');
    await createFakeApp(sourceApp, '0.0.0', 'local');

    const result = await installSessionDeckDesktop({
      fromPath: sourceApp,
      homeDirectory: home,
      now: () => NOW,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
      sha256: await hashSessionDeckDesktopPath(sourceApp),
    });

    const targetApp = getDefaultSessionDeckDesktopAppPath(home);
    await expect(lstat(targetApp)).resolves.toMatchObject({});
    await expect(executableMarker(home)).resolves.toBe('local');
    const state = await readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home));
    expect(result.level).toBe('info');
    expect(result.message).toContain('Installed Session Deck desktop app.');
    expect(state).toMatchObject({
      installedAt: NOW.toISOString(),
      packageVersion: RELEASE_VERSION,
      app: {
        path: targetApp,
        version: '0.0.0',
      },
      source: {
        kind: 'local-path',
        path: resolve(sourceApp),
        sha256: await hashSessionDeckDesktopPath(sourceApp),
      },
      runtime: {
        packageRoot: root,
        helperPackageVersion: RELEASE_VERSION,
      },
      ownedPaths: [targetApp],
    });
  });

  it('fails local checksum verification without writing app or state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const sourceApp = join(root, 'Session Deck Desktop.app');
    await createFakeApp(sourceApp, '0.0.0', 'local');

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

  it('rejects a requested version differing from the running package before fetching or staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    let fetched = false;
    const fetch: SessionDeckDesktopFetch = async () => {
      fetched = true;
      throw new Error('unexpected fetch');
    };

    const result = await installSessionDeckDesktop({
      fetch,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
      version: '0.10.0',
    });

    expect(result).toEqual({
      level: 'error',
      message: `Requested desktop version 0.10.0 does not match running package version ${RELEASE_VERSION}.`,
    });
    expect(fetched).toBe(false);
    await expect(lstat(join(home, '.pi'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects --from-path with --version at the installer boundary', async () => {
    const result = await installSessionDeckDesktop({
      fromPath: '/tmp/Session Deck Desktop.app',
      platform: 'darwin',
      version: RELEASE_VERSION,
    });

    expect(result).toEqual({
      level: 'error',
      message: '--from-path and --version cannot be used together.',
    });
  });

  it('rejects a downloaded bundle version mismatch while preserving the old app and state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const oldApp = join(root, 'old', 'Session Deck Desktop.app');
    await createFakeApp(oldApp, '0.0.0', 'old');
    await installSessionDeckDesktop({
      fromPath: oldApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });
    const oldState = await readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home));
    const release = createReleaseFetch({ arch: 'arm64', archive: Buffer.from('mismatch zip') });

    const result = await installSessionDeckDesktop({
      arch: 'arm64',
      execFile: createDittoExtractor('0.10.0', 'downloaded'),
      fetch: release.fetch,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain(
      `Downloaded app bundle version 0.10.0 does not match requested version ${RELEASE_VERSION}.`,
    );
    await expect(executableMarker(home)).resolves.toBe('old');
    await expect(
      readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home)),
    ).resolves.toEqual(oldState);
  });

  it('restores the previous app and state when the pre-commit state rename fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const firstApp = join(root, 'first', 'Session Deck Desktop.app');
    const secondApp = join(root, 'second', 'Session Deck Desktop.app');
    await createFakeApp(firstApp, '0.0.0', 'v1');
    await createFakeApp(secondApp, '0.0.0', 'v2');
    await installSessionDeckDesktop({
      fromPath: firstApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    const statePath = getSessionDeckDesktopStatePath(home);
    const oldState = await readSessionDeckDesktopInstallState(statePath);
    const result = await installSessionDeckDesktop({
      fromPath: secondApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
      renamePath: async (oldPath, newPath) => {
        if (newPath === statePath) {
          expect((await lstat(oldPath)).mode & 0o777).toBe(0o600);
          throw new Error('state commit blocked');
        }
        await rename(oldPath, newPath);
      },
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain('state commit blocked');
    expect(result.message).toContain('Previous app install and state were preserved.');
    await expect(executableMarker(home)).resolves.toBe('v1');
    await expect(readSessionDeckDesktopInstallState(statePath)).resolves.toEqual(oldState);
  });

  it('preserves the original error and reports recovery paths when rollback cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const firstApp = join(root, 'first', 'Session Deck Desktop.app');
    const secondApp = join(root, 'second', 'Session Deck Desktop.app');
    await createFakeApp(firstApp, '0.0.0', 'v1');
    await createFakeApp(secondApp, '0.0.0', 'v2');
    await installSessionDeckDesktop({
      fromPath: firstApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    const targetAppPath = getDefaultSessionDeckDesktopAppPath(home);
    const statePath = getSessionDeckDesktopStatePath(home);
    const result = await installSessionDeckDesktop({
      fromPath: secondApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
      removePath: async (path) => {
        if (path === targetAppPath) throw new Error('new app cleanup blocked');
        await rm(path, { force: true, recursive: true });
      },
      renamePath: async (oldPath, newPath) => {
        if (newPath === statePath) throw new Error('state commit blocked');
        await rename(oldPath, newPath);
      },
    });

    const backupName = (await readdir(dirname(targetAppPath))).find((name) =>
      name.endsWith('.previous'),
    );
    expect(result).toMatchObject({ level: 'error' });
    expect(result.message.indexOf('state commit blocked')).toBeLessThan(
      result.message.indexOf('Rollback failed: new app cleanup blocked'),
    );
    expect(result.message).toContain(`app ${targetAppPath}`);
    expect(result.message).toContain(`state ${statePath}`);
    expect(backupName).toBeDefined();
    expect(result.message).toContain(join(dirname(targetAppPath), backupName!));
    await expect(
      readFile(
        join(dirname(targetAppPath), backupName!, 'Contents', 'MacOS', 'session-deck-desktop'),
        'utf8',
      ),
    ).resolves.toBe('v1');
    await expect(executableMarker(home)).resolves.toBe('v2');
    await expect(readSessionDeckDesktopInstallState(statePath)).resolves.toMatchObject({
      source: { path: resolve(firstApp) },
    });
  });

  it('keeps committed app and state when backup and work directory cleanup fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const firstApp = join(root, 'first', 'Session Deck Desktop.app');
    const secondApp = join(root, 'second', 'Session Deck Desktop.app');
    await createFakeApp(firstApp, '0.0.0', 'v1');
    await createFakeApp(secondApp, '0.0.0', 'v2');
    await installSessionDeckDesktop({
      fromPath: firstApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    const result = await installSessionDeckDesktop({
      fromPath: secondApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
      removePath: async (path) => {
        if (path.endsWith('.previous') || path.includes(join('desktop', 'tmp'))) {
          throw new Error('cleanup blocked');
        }
        await rm(path, { force: true, recursive: true });
      },
    });

    expect(result).toMatchObject({ level: 'warning' });
    expect(result.message).toContain('Installed Session Deck desktop app.');
    expect(result.message).toContain('Warning: cleanup left');
    expect(result.message).toContain('.previous');
    expect(result.message).toContain(join('desktop', 'tmp'));
    await expect(executableMarker(home)).resolves.toBe('v2');
    await expect(
      readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home)),
    ).resolves.toMatchObject({ source: { path: resolve(secondApp) } });
  });

  it.each(['arm64', 'x64'] as const)(
    'joins the %s GitHub release download, checksum, ditto extraction, validation, and commit',
    async (arch) => {
      const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
      const home = join(root, 'home');
      const archive = Buffer.from(`release archive ${arch}`);
      const release = createReleaseFetch({ arch, archive });

      const result = await installSessionDeckDesktop({
        arch,
        execFile: createDittoExtractor(RELEASE_VERSION, `release-${arch}`),
        fetch: release.fetch,
        homeDirectory: home,
        now: () => NOW,
        platform: 'darwin',
        runtimePaths: runtimePaths(root),
      });

      const state = await readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home));
      expect(result).toMatchObject({ level: 'info' });
      await expect(executableMarker(home)).resolves.toBe(`release-${arch}`);
      expect(release.requestedUrls[0]).toContain(
        `/releases/tags/${getSessionDeckDesktopReleaseTag(RELEASE_VERSION)}`,
      );
      expect(release.requestedUrls.slice(1)).toEqual([
        `https://downloads.test/${release.assetName}.sha256`,
        `https://downloads.test/${release.assetName}`,
      ]);
      expect(state).toMatchObject({
        packageVersion: RELEASE_VERSION,
        app: { version: RELEASE_VERSION },
        source: {
          kind: 'github-release',
          releaseTag: getSessionDeckDesktopReleaseTag(RELEASE_VERSION),
          assetName: release.assetName,
          url: `https://downloads.test/${release.assetName}`,
          sha256: hashSessionDeckDesktopContent(archive),
        },
      });
    },
  );
});
