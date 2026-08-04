import { rename, readdir, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installSessionDeckDesktop as installSessionDeckDesktopProduction,
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

function createQuarantineExecFile(options: {
  marker?: string;
  quarantine?: Map<string, string>;
  readValue?: (path: string, currentValue: string | undefined) => string | undefined;
  version?: string;
  writeError?: Error;
}): {
  calls: Array<{ file: string; args: string[] }>;
  execFile: SessionDeckDesktopExecFile;
  quarantine: Map<string, string>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const quarantine = options.quarantine ?? new Map<string, string>();
  const execFile: SessionDeckDesktopExecFile = (file, args, callback) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/ditto') {
      void createFakeApp(
        join(args[3]!, 'Session Deck Desktop.app'),
        options.version ?? RELEASE_VERSION,
        options.marker ?? 'downloaded',
      ).then(
        () => callback(null),
        (error: unknown) => callback(error as Error),
      );
      return;
    }

    if (file !== '/usr/bin/xattr') {
      callback(new Error(`Unexpected executable: ${file}`));
      return;
    }

    if (args[0] === '-p') {
      const path = args[2]!;
      const currentValue = quarantine.get(path);
      const value = options.readValue?.(path, currentValue) ?? currentValue;
      if (value === undefined) {
        const error = Object.assign(
          new Error(`No such xattr: ${SESSION_DECK_QUARANTINE_ATTRIBUTE}`),
          { code: 1 },
        );
        callback(
          error,
          '',
          `xattr: ${path}: No such xattr: ${SESSION_DECK_QUARANTINE_ATTRIBUTE}\n`,
        );
        return;
      }
      callback(null, `${value}\n`);
      return;
    }

    if (args[0] === '-w') {
      if (options.writeError !== undefined) {
        callback(options.writeError);
        return;
      }
      quarantine.set(args[3]!, args[2]!);
      callback(null);
      return;
    }

    callback(new Error(`Unexpected xattr arguments: ${args.join(' ')}`));
  };

  return { calls, execFile, quarantine };
}

function installSessionDeckDesktop(
  options: Parameters<typeof installSessionDeckDesktopProduction>[0] = {},
): ReturnType<typeof installSessionDeckDesktopProduction> {
  return installSessionDeckDesktopProduction({
    execFile: createQuarantineExecFile({}).execFile,
    ...options,
  });
}

const SESSION_DECK_QUARANTINE_ATTRIBUTE = 'com.apple.quarantine';

async function renameWithQuarantine(
  quarantine: Map<string, string>,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await rename(oldPath, newPath);
  const value = quarantine.get(oldPath);
  if (value !== undefined) {
    quarantine.delete(oldPath);
    quarantine.set(newPath, value);
  }
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
    expect(result.message).toContain(
      'leave the app installed at the initial warning, then use System Settings → Privacy & Security → Open Anyway.',
    );
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

  it('marks a GitHub release app before commit and verifies the exact quarantine value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const archive = Buffer.from('release archive quarantine');
    const release = createReleaseFetch({ arch: 'arm64', archive });
    const quarantine = createQuarantineExecFile({
      marker: 'release',
      version: RELEASE_VERSION,
    });
    const targetAppPath = getDefaultSessionDeckDesktopAppPath(home);

    const result = await installSessionDeckDesktop({
      arch: 'arm64',
      execFile: quarantine.execFile,
      fetch: release.fetch,
      homeDirectory: home,
      now: () => NOW,
      platform: 'darwin',
      renamePath: (oldPath, newPath) =>
        renameWithQuarantine(quarantine.quarantine, oldPath, newPath),
      runtimePaths: runtimePaths(root),
    });

    const writes = quarantine.calls.filter(
      (call) => call.file === '/usr/bin/xattr' && call.args[0] === '-w',
    );
    expect(result.level).toBe('info');
    expect(writes).toHaveLength(1);
    const value = writes[0]!.args[2]!;
    expect(value).toMatch(
      new RegExp(
        `^0081;${Math.floor(NOW.getTime() / 1000).toString(16)};Session Deck;[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$`,
      ),
    );
    expect(quarantine.quarantine.get(targetAppPath)).toBe(value);
    expect(
      quarantine.calls.some(
        (call) =>
          call.file === '/usr/bin/xattr' &&
          call.args[0] === '-p' &&
          call.args[1] === SESSION_DECK_QUARANTINE_ATTRIBUTE &&
          call.args[2] === writes[0]!.args[3],
      ),
    ).toBe(true);
  });

  it('preserves the old app and state when quarantine marking fails before commit', async () => {
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
    const release = createReleaseFetch({ arch: 'arm64', archive: Buffer.from('release archive') });
    const quarantine = createQuarantineExecFile({
      version: RELEASE_VERSION,
      writeError: new Error('quarantine write blocked'),
    });

    const result = await installSessionDeckDesktop({
      arch: 'arm64',
      execFile: quarantine.execFile,
      fetch: release.fetch,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain('quarantine write blocked');
    await expect(executableMarker(home)).resolves.toBe('old');
    await expect(
      readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home)),
    ).resolves.toEqual(oldState);
  });

  it('preserves the old app and state when quarantine readback mismatches', async () => {
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
    const release = createReleaseFetch({ arch: 'arm64', archive: Buffer.from('release archive') });
    const quarantine = createQuarantineExecFile({
      readValue: () => '0081;wrong;Session Deck;WRONG',
      version: RELEASE_VERSION,
    });

    const result = await installSessionDeckDesktop({
      arch: 'arm64',
      execFile: quarantine.execFile,
      fetch: release.fetch,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain('com.apple.quarantine verification failed');
    await expect(executableMarker(home)).resolves.toBe('old');
    await expect(
      readSessionDeckDesktopInstallState(getSessionDeckDesktopStatePath(home)),
    ).resolves.toEqual(oldState);
  });

  it('preserves local quarantine and does not invent it when absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const sourceApp = join(root, 'Session Deck Desktop.app');
    await createFakeApp(sourceApp, '0.0.0', 'local');
    const localValue = '0081;6798f6c0;Safari;ABCDEFAB-1234-5678-9ABC-DEF012345678';
    const quarantine = createQuarantineExecFile({
      quarantine: new Map([[resolve(sourceApp), localValue]]),
    });

    const preservedResult = await installSessionDeckDesktop({
      execFile: quarantine.execFile,
      fromPath: sourceApp,
      homeDirectory: home,
      platform: 'darwin',
      renamePath: (oldPath, newPath) =>
        renameWithQuarantine(quarantine.quarantine, oldPath, newPath),
      runtimePaths: runtimePaths(root),
    });

    const targetAppPath = getDefaultSessionDeckDesktopAppPath(home);
    expect(preservedResult.level).toBe('info');
    expect(quarantine.quarantine.get(targetAppPath)).toBe(localValue);
    expect(
      quarantine.calls
        .filter((call) => call.file === '/usr/bin/xattr' && call.args[0] === '-w')
        .map((call) => call.args[2]),
    ).toEqual([localValue]);

    const noQuarantineSource = join(root, 'No Quarantine.app');
    const noQuarantineHome = join(root, 'no-quarantine-home');
    await createFakeApp(noQuarantineSource, '0.0.0', 'local-no-quarantine');
    const noQuarantine = createQuarantineExecFile({});
    const noQuarantineResult = await installSessionDeckDesktop({
      execFile: noQuarantine.execFile,
      fromPath: noQuarantineSource,
      homeDirectory: noQuarantineHome,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(noQuarantineResult.level).toBe('info');
    expect(noQuarantine.quarantine.has(getDefaultSessionDeckDesktopAppPath(noQuarantineHome))).toBe(
      false,
    );
    expect(
      noQuarantine.calls.filter((call) => call.file === '/usr/bin/xattr' && call.args[0] === '-w'),
    ).toHaveLength(0);
  });

  it('preserves quarantine from local ZIP and DMG sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const localValue = '0081;6798f6c0;Browser;ABCDEFAB-1234-5678-9ABC-DEF012345678';

    const zipPath = join(root, 'Session Deck Desktop.zip');
    const zipHome = join(root, 'zip-home');
    await writeFile(zipPath, 'zip bytes');
    const zipQuarantine = createQuarantineExecFile({
      quarantine: new Map([[resolve(zipPath), localValue]]),
      marker: 'zip',
      version: '0.0.0',
    });
    const zipResult = await installSessionDeckDesktop({
      execFile: zipQuarantine.execFile,
      fromPath: zipPath,
      homeDirectory: zipHome,
      platform: 'darwin',
      renamePath: (oldPath, newPath) =>
        renameWithQuarantine(zipQuarantine.quarantine, oldPath, newPath),
      runtimePaths: runtimePaths(root),
    });

    const dmgPath = join(root, 'Session Deck Desktop.dmg');
    const dmgHome = join(root, 'dmg-home');
    await writeFile(dmgPath, 'dmg bytes');
    const dmgQuarantine = createQuarantineExecFile({
      quarantine: new Map([[resolve(dmgPath), localValue]]),
      marker: 'dmg',
      version: '0.0.0',
    });
    const dmgExecFile: SessionDeckDesktopExecFile = (file, args, callback) => {
      if (file !== '/usr/bin/hdiutil') {
        dmgQuarantine.execFile(file, args, callback);
        return;
      }
      if (args[0] === 'attach') {
        void createFakeApp(join(args[4]!, 'Session Deck Desktop.app'), '0.0.0', 'dmg').then(
          () => callback(null),
          (error: unknown) => callback(error as Error),
        );
        return;
      }
      callback(null);
    };
    const dmgResult = await installSessionDeckDesktop({
      execFile: dmgExecFile,
      fromPath: dmgPath,
      homeDirectory: dmgHome,
      platform: 'darwin',
      renamePath: (oldPath, newPath) =>
        renameWithQuarantine(dmgQuarantine.quarantine, oldPath, newPath),
      runtimePaths: runtimePaths(root),
    });

    expect(zipResult.level).toBe('info');
    expect(dmgResult.level).toBe('info');
    expect(zipQuarantine.quarantine.get(getDefaultSessionDeckDesktopAppPath(zipHome))).toBe(
      localValue,
    );
    expect(dmgQuarantine.quarantine.get(getDefaultSessionDeckDesktopAppPath(dmgHome))).toBe(
      localValue,
    );
  });

  it('fails a local quarantine read instead of hiding an unrelated xattr error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-deck-desktop-install-'));
    const home = join(root, 'home');
    const sourceApp = join(root, 'Session Deck Desktop.app');
    await createFakeApp(sourceApp, '0.0.0', 'local');
    const quarantine = createQuarantineExecFile({
      readValue: () => {
        throw new Error('xattr helper failed unexpectedly');
      },
    });

    const result = await installSessionDeckDesktop({
      execFile: quarantine.execFile,
      fromPath: sourceApp,
      homeDirectory: home,
      platform: 'darwin',
      runtimePaths: runtimePaths(root),
    });

    expect(result).toMatchObject({ level: 'error' });
    expect(result.message).toContain('xattr helper failed unexpectedly');
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
      const quarantine = createQuarantineExecFile({
        marker: `release-${arch}`,
        version: RELEASE_VERSION,
      });

      const result = await installSessionDeckDesktop({
        arch,
        execFile: quarantine.execFile,
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
