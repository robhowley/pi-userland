import { randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { downloadSessionDeckDesktopArtifact, type SessionDeckDesktopFetch } from './artifact.js';
import { findSessionDeckDesktopAppBundle, validateSessionDeckDesktopAppBundle } from './bundle.js';
import {
  getDefaultSessionDeckDesktopAppPath,
  getSessionDeckDesktopStatePath,
  getSessionDeckDesktopTmpDir,
  resolveSessionDeckDesktopRuntimePaths,
  SESSION_DECK_DESKTOP_APP_BUNDLE_NAME,
  SESSION_DECK_DESKTOP_PACKAGE_NAME,
  type SessionDeckDesktopRuntimePaths,
} from './paths.js';
import {
  hashSessionDeckDesktopPath,
  readSessionDeckDesktopInstallState,
  writeSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
  type SessionDeckDesktopSourceState,
} from './state.js';
import type { SessionDeckDesktopCommandResult } from './command.js';

export type SessionDeckDesktopExecFile = (
  file: string,
  args: string[],
  callback: (error: Error | null) => void,
) => void;

export interface InstallSessionDeckDesktopOptions {
  arch?: NodeJS.Architecture;
  destinationAppPath?: string;
  execFile?: SessionDeckDesktopExecFile;
  fetch?: SessionDeckDesktopFetch;
  fromPath?: string;
  homeDirectory?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckDesktopRuntimePaths;
  sha256?: string;
  statePath?: string;
  version?: string;
  writeInstallState?: typeof writeSessionDeckDesktopInstallState;
}

interface PreparedDesktopArtifact {
  appPath: string;
  source: SessionDeckDesktopSourceState;
}

export async function installSessionDeckDesktop(
  options: InstallSessionDeckDesktopOptions = {},
): Promise<SessionDeckDesktopCommandResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      level: 'error',
      message: `Session Deck desktop install is only supported on macOS, not ${platform}.`,
    };
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckDesktopStatePath(homeDirectory);
  const targetAppPath =
    options.destinationAppPath ?? getDefaultSessionDeckDesktopAppPath(homeDirectory);
  let existingState: SessionDeckDesktopInstallState | null;
  try {
    existingState = await readSessionDeckDesktopInstallState(statePath);
  } catch (error) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck desktop app.',
        `State file at ${statePath} is invalid: ${getErrorMessage(error)}`,
        'Remove or repair the state file and verify/remove any existing Session Deck desktop app manually before installing.',
      ].join('\n'),
    };
  }

  if (existingState !== null && existingState.app.path !== targetAppPath) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck desktop app.',
        `Existing state owns ${existingState.app.path}.`,
        `Requested install target is ${targetAppPath}.`,
        'Run /session-deck desktop uninstall first, or reinstall to the same managed app path.',
      ].join('\n'),
    };
  }

  if ((await pathExists(targetAppPath)) && existingState === null) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck desktop app.',
        `App target already exists and is not owned by Session Deck state: ${targetAppPath}`,
        'Nothing was overwritten. Move or verify the existing app manually, then rerun /session-deck desktop install.',
      ].join('\n'),
    };
  }

  let runtimePaths: SessionDeckDesktopRuntimePaths;
  try {
    runtimePaths =
      options.runtimePaths ?? (await resolveSessionDeckDesktopRuntimePaths(import.meta.url));
  } catch (error) {
    return {
      level: 'error',
      message: [
        'Could not install Session Deck desktop app.',
        `Could not resolve the current @robhowley/pi-session-deck runtime: ${getErrorMessage(error)}`,
      ].join('\n'),
    };
  }

  const installId = randomUUID();
  const workDir = join(getSessionDeckDesktopTmpDir(homeDirectory), installId);
  const stagedAppPath = join(
    dirname(targetAppPath),
    `.${SESSION_DECK_DESKTOP_APP_BUNDLE_NAME}.${process.pid}.${installId}.tmp`,
  );

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const prepared =
      options.fromPath === undefined
        ? await prepareDownloadedArtifact({
            ...(options.arch === undefined ? {} : { arch: options.arch }),
            ...(options.execFile === undefined ? {} : { execFile: options.execFile }),
            ...(options.sha256 === undefined ? {} : { expectedSha256: options.sha256 }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            platform,
            runtimePaths,
            ...(options.version === undefined ? {} : { version: options.version }),
            workDir,
          })
        : await prepareLocalArtifact({
            ...(options.execFile === undefined ? {} : { execFile: options.execFile }),
            ...(options.sha256 === undefined ? {} : { expectedSha256: options.sha256 }),
            fromPath: options.fromPath,
            platform,
            workDir,
          });

    const bundle = await validateSessionDeckDesktopAppBundle(prepared.appPath);
    await mkdir(dirname(stagedAppPath), { recursive: true });
    await copyAppBundle(prepared.appPath, stagedAppPath);
    const installedSha256 = await hashSessionDeckDesktopPath(stagedAppPath);
    const state: SessionDeckDesktopInstallState = {
      schemaVersion: 1,
      product: 'session-deck-desktop',
      packageName: SESSION_DECK_DESKTOP_PACKAGE_NAME,
      packageVersion: runtimePaths.packageVersion,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
      app: {
        path: targetAppPath,
        bundleIdentifier: bundle.bundleIdentifier,
        name: bundle.name,
        version: bundle.version,
        sha256: installedSha256,
      },
      source: prepared.source,
      runtime: {
        nodeExecutablePath: runtimePaths.nodeExecutablePath,
        packageRoot: runtimePaths.packageRoot,
        helperPackageVersion: runtimePaths.packageVersion,
      },
      ownedPaths: [targetAppPath],
    };

    await commitManagedAppInstall({
      state,
      statePath,
      stagedAppPath,
      targetAppPath,
      writeInstallState: options.writeInstallState ?? writeSessionDeckDesktopInstallState,
    });

    return {
      level: 'info',
      message: [
        'Installed Session Deck desktop app.',
        `App: ${targetAppPath}`,
        `State: ${statePath}`,
        `Source: ${formatSource(prepared.source)}`,
        'Next: run /session-deck desktop open, or /session-deck desktop doctor for diagnostics.',
      ].join('\n'),
    };
  } catch (error) {
    await rm(stagedAppPath, { recursive: true, force: true });
    return {
      level: 'error',
      message: ['Could not install Session Deck desktop app.', getErrorMessage(error)].join('\n'),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function prepareDownloadedArtifact(options: {
  arch?: NodeJS.Architecture;
  execFile?: SessionDeckDesktopExecFile;
  expectedSha256?: string;
  fetch?: SessionDeckDesktopFetch;
  platform: NodeJS.Platform;
  runtimePaths: SessionDeckDesktopRuntimePaths;
  version?: string;
  workDir: string;
}): Promise<PreparedDesktopArtifact> {
  const version = options.version ?? options.runtimePaths.packageVersion;
  const downloaded = await downloadSessionDeckDesktopArtifact({
    version,
    workDir: options.workDir,
    platform: options.platform,
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
  });
  const appPath = await extractZipArtifact(downloaded.path, options.workDir, {
    execFile: options.execFile ?? nodeExecFileAdapter,
    platform: options.platform,
  });

  return {
    appPath,
    source: {
      kind: 'github-release',
      releaseTag: downloaded.releaseTag,
      assetName: downloaded.assetName,
      url: downloaded.assetUrl,
      sha256: downloaded.sha256,
    },
  };
}

async function prepareLocalArtifact(options: {
  execFile?: SessionDeckDesktopExecFile;
  expectedSha256?: string;
  fromPath: string;
  platform: NodeJS.Platform;
  workDir: string;
}): Promise<PreparedDesktopArtifact> {
  const sourcePath = resolve(options.fromPath);
  const sourceSha256 = await hashSessionDeckDesktopPath(sourcePath);
  verifyExpectedSha256(sourceSha256, options.expectedSha256, sourcePath);

  const source: SessionDeckDesktopSourceState = {
    kind: 'local-path',
    path: sourcePath,
    sha256: sourceSha256,
  };
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isDirectory() && extname(sourcePath) === '.app') {
    return { appPath: sourcePath, source };
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported local desktop artifact type: ${sourcePath}`);
  }

  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.zip') {
    return {
      appPath: await extractZipArtifact(sourcePath, options.workDir, {
        execFile: options.execFile ?? nodeExecFileAdapter,
        platform: options.platform,
      }),
      source,
    };
  }

  if (extension === '.dmg') {
    return {
      appPath: await extractDmgArtifact(sourcePath, options.workDir, {
        execFile: options.execFile ?? nodeExecFileAdapter,
        platform: options.platform,
      }),
      source,
    };
  }

  throw new Error(
    `Unsupported local desktop artifact extension ${extension || '<none>'}: ${sourcePath}`,
  );
}

async function extractZipArtifact(
  zipPath: string,
  workDir: string,
  options: { execFile: SessionDeckDesktopExecFile; platform: NodeJS.Platform },
): Promise<string> {
  if (options.platform !== 'darwin') {
    throw new Error(
      'Installing Session Deck desktop .zip artifacts requires macOS /usr/bin/ditto.',
    );
  }

  const extractDir = join(workDir, 'zip-extract');
  await mkdir(extractDir, { recursive: true, mode: 0o700 });
  await execFilePromise(options.execFile, '/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);
  return findSessionDeckDesktopAppBundle(extractDir);
}

async function extractDmgArtifact(
  dmgPath: string,
  workDir: string,
  options: { execFile: SessionDeckDesktopExecFile; platform: NodeJS.Platform },
): Promise<string> {
  if (options.platform !== 'darwin') {
    throw new Error(
      'Installing Session Deck desktop .dmg artifacts requires macOS /usr/bin/hdiutil.',
    );
  }

  const mountDir = join(workDir, 'dmg-mount');
  const extractedDir = join(workDir, 'dmg-extract');
  await mkdir(mountDir, { recursive: true, mode: 0o700 });
  await mkdir(extractedDir, { recursive: true, mode: 0o700 });
  let mounted = false;
  try {
    await execFilePromise(options.execFile, '/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountDir,
      dmgPath,
    ]);
    mounted = true;
    const mountedApp = await findSessionDeckDesktopAppBundle(mountDir);
    const extractedApp = join(extractedDir, basename(mountedApp));
    await copyAppBundle(mountedApp, extractedApp);
    return extractedApp;
  } finally {
    if (mounted) {
      await execFilePromise(options.execFile, '/usr/bin/hdiutil', ['detach', mountDir]).catch(
        () => undefined,
      );
    }
  }
}

async function commitManagedAppInstall(options: {
  state: SessionDeckDesktopInstallState;
  statePath: string;
  stagedAppPath: string;
  targetAppPath: string;
  writeInstallState: typeof writeSessionDeckDesktopInstallState;
}): Promise<void> {
  await mkdir(dirname(options.targetAppPath), { recursive: true });
  const previousAppPath = join(
    dirname(options.targetAppPath),
    `.${basename(options.targetAppPath)}.${process.pid}.${randomUUID()}.previous`,
  );
  const hadPreviousApp = await pathExists(options.targetAppPath);
  let installedTarget = false;
  if (hadPreviousApp) {
    await rename(options.targetAppPath, previousAppPath);
  }

  try {
    await rename(options.stagedAppPath, options.targetAppPath);
    installedTarget = true;
    await options.writeInstallState(options.statePath, options.state);
    if (hadPreviousApp) {
      await rm(previousAppPath, { recursive: true, force: true });
    }
  } catch (error) {
    const rollbackMessage = await rollbackManagedAppInstall({
      hadPreviousApp,
      installedTarget,
      previousAppPath,
      targetAppPath: options.targetAppPath,
    });
    throw new Error(`${getErrorMessage(error)} ${rollbackMessage}`);
  }
}

async function rollbackManagedAppInstall(options: {
  hadPreviousApp: boolean;
  installedTarget: boolean;
  previousAppPath: string;
  targetAppPath: string;
}): Promise<string> {
  try {
    if (options.installedTarget) {
      await rm(options.targetAppPath, { recursive: true, force: true });
    }

    if (options.hadPreviousApp) {
      await rename(options.previousAppPath, options.targetAppPath);
      return 'Previous app install was restored.';
    }

    return 'No previous app install existed; partial app copy was removed.';
  } catch (error) {
    return `Rollback failed: ${getErrorMessage(error)}`;
  }
}

async function copyAppBundle(sourcePath: string, targetPath: string): Promise<void> {
  const sourceRealPath = await realpath(sourcePath);
  await copyDirectory(sourceRealPath, targetPath);
}

async function copyDirectory(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink from Session Deck desktop artifact: ${sourcePath}`);
  }

  if (!sourceStat.isDirectory()) {
    throw new Error(`Expected directory while copying Session Deck desktop app: ${sourcePath}`);
  }

  await mkdir(targetPath, { mode: sourceStat.mode & 0o777 });
  await chmod(targetPath, sourceStat.mode & 0o777);
  const entries = (await readdir(sourcePath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const sourceEntryPath = join(sourcePath, entry.name);
    const targetEntryPath = join(targetPath, entry.name);
    const entryStat = await lstat(sourceEntryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(
        `Refusing to copy symlink from Session Deck desktop artifact: ${sourceEntryPath}`,
      );
    }

    if (entryStat.isDirectory()) {
      await copyDirectory(sourceEntryPath, targetEntryPath);
      continue;
    }

    if (entryStat.isFile()) {
      await copyFile(sourceEntryPath, targetEntryPath);
      await chmod(targetEntryPath, entryStat.mode & 0o777);
      continue;
    }

    throw new Error(`Refusing to copy unsupported app bundle entry: ${sourceEntryPath}`);
  }
}

async function execFilePromise(
  execFile: SessionDeckDesktopExecFile,
  file: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(file, args, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

const nodeExecFileAdapter: SessionDeckDesktopExecFile = (file, args, callback) => {
  const child = nodeExecFile(file, args, (error) => callback(error));
  child.stdin?.end();
};

function verifyExpectedSha256(
  actualSha256: string,
  expectedSha256: string | undefined,
  label: string,
): void {
  if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
    throw new Error(
      `Checksum mismatch for ${label}: expected ${expectedSha256}, got ${actualSha256}.`,
    );
  }
}

function formatSource(source: SessionDeckDesktopSourceState): string {
  return source.kind === 'local-path'
    ? `${source.path} (${source.sha256})`
    : `${source.releaseTag}/${source.assetName} (${source.sha256})`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
