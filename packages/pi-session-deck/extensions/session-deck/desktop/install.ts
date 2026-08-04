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
  SESSION_DECK_DESKTOP_FIRST_LAUNCH_GUIDANCE,
  getSessionDeckDesktopTmpDir,
  resolveSessionDeckDesktopRuntimePaths,
  SESSION_DECK_DESKTOP_APP_BUNDLE_NAME,
  SESSION_DECK_DESKTOP_PACKAGE_NAME,
  type SessionDeckDesktopRuntimePaths,
} from './paths.js';
import {
  hashSessionDeckDesktopPath,
  readSessionDeckDesktopInstallState,
  stageSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
  type SessionDeckDesktopSourceState,
} from './state.js';
import type { SessionDeckDesktopCommandResult } from './command.js';

export type SessionDeckDesktopExecFile = (
  file: string,
  args: string[],
  callback: (error: Error | null, stdout?: string, stderr?: string) => void,
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
  removePath?: (path: string) => Promise<void>;
  renamePath?: (oldPath: string, newPath: string) => Promise<void>;
}

interface PreparedDesktopArtifact {
  appPath: string;
  rootQuarantine: string | null;
  source: SessionDeckDesktopSourceState;
}

interface ExtractedDmgArtifact {
  appPath: string;
  rootQuarantine: string | null;
}

const SESSION_DECK_DESKTOP_XATTR_PATH = '/usr/bin/xattr';
const SESSION_DECK_DESKTOP_QUARANTINE_ATTRIBUTE = 'com.apple.quarantine';

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

  if (options.fromPath !== undefined && options.version !== undefined) {
    return {
      level: 'error',
      message: '--from-path and --version cannot be used together.',
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

  if (options.version !== undefined && options.version !== runtimePaths.packageVersion) {
    return {
      level: 'error',
      message: `Requested desktop version ${options.version} does not match running package version ${runtimePaths.packageVersion}.`,
    };
  }

  const installId = randomUUID();
  const workDir = join(getSessionDeckDesktopTmpDir(homeDirectory), installId);
  const stagedAppPath = join(
    dirname(targetAppPath),
    `.${SESSION_DECK_DESKTOP_APP_BUNDLE_NAME}.${process.pid}.${installId}.tmp`,
  );
  const removePath = options.removePath ?? removeInstallPath;
  const renamePath = options.renamePath ?? rename;
  const execFile = options.execFile ?? nodeExecFileAdapter;
  const cleanupWarnings: string[] = [];

  try {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const prepared =
      options.fromPath === undefined
        ? await prepareDownloadedArtifact({
            ...(options.arch === undefined ? {} : { arch: options.arch }),
            execFile,
            ...(options.sha256 === undefined ? {} : { expectedSha256: options.sha256 }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            platform,
            runtimePaths,
            workDir,
          })
        : await prepareLocalArtifact({
            execFile,
            ...(options.sha256 === undefined ? {} : { expectedSha256: options.sha256 }),
            fromPath: options.fromPath,
            platform,
            workDir,
          });

    const bundle = await validateSessionDeckDesktopAppBundle(prepared.appPath);
    if (
      prepared.source.kind === 'github-release' &&
      bundle.version !== runtimePaths.packageVersion
    ) {
      throw new Error(
        `Downloaded app bundle version ${bundle.version} does not match requested version ${runtimePaths.packageVersion}.`,
      );
    }

    await mkdir(dirname(stagedAppPath), { recursive: true });
    await copyAppBundle(prepared.appPath, stagedAppPath);
    const installedSha256 = await hashSessionDeckDesktopPath(stagedAppPath);
    const installedAt = (options.now ?? (() => new Date()))();
    await applyRootQuarantine({
      appPath: stagedAppPath,
      execFile,
      installedAt,
      rootQuarantine: prepared.rootQuarantine,
      source: prepared.source,
    });
    const state: SessionDeckDesktopInstallState = {
      schemaVersion: 1,
      product: 'session-deck-desktop',
      packageName: SESSION_DECK_DESKTOP_PACKAGE_NAME,
      packageVersion: runtimePaths.packageVersion,
      installedAt: installedAt.toISOString(),
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

    cleanupWarnings.push(
      ...(await commitManagedAppInstall({
        state,
        statePath,
        stagedAppPath,
        targetAppPath,
        removePath,
        renamePath,
      })),
    );
    const workDirWarning = await removeInstallPathWithWarning(workDir, removePath);
    if (workDirWarning !== null) cleanupWarnings.push(workDirWarning);

    return {
      level: cleanupWarnings.length === 0 ? 'info' : 'warning',
      message: [
        'Installed Session Deck desktop app.',
        `App: ${targetAppPath}`,
        `State: ${statePath}`,
        `Source: ${formatSource(prepared.source)}`,
        ...cleanupWarnings,
        'Next: double-click Session Deck Desktop in Applications, or run /session-deck desktop open.',
        SESSION_DECK_DESKTOP_FIRST_LAUNCH_GUIDANCE,
        'For diagnostics, run /session-deck desktop doctor.',
      ].join('\n'),
    };
  } catch (error) {
    for (const path of [stagedAppPath, workDir]) {
      const warning = await removeInstallPathWithWarning(path, removePath);
      if (warning !== null) cleanupWarnings.push(warning);
    }
    return {
      level: 'error',
      message: [
        'Could not install Session Deck desktop app.',
        getErrorMessage(error),
        ...cleanupWarnings,
      ].join('\n'),
    };
  }
}

async function prepareDownloadedArtifact(options: {
  arch?: NodeJS.Architecture;
  execFile?: SessionDeckDesktopExecFile;
  expectedSha256?: string;
  fetch?: SessionDeckDesktopFetch;
  platform: NodeJS.Platform;
  runtimePaths: SessionDeckDesktopRuntimePaths;
  workDir: string;
}): Promise<PreparedDesktopArtifact> {
  const downloaded = await downloadSessionDeckDesktopArtifact({
    version: options.runtimePaths.packageVersion,
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
    rootQuarantine: null,
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

  const execFile = options.execFile ?? nodeExecFileAdapter;
  const sourceQuarantine = await readQuarantineAttribute(execFile, sourcePath);
  const source: SessionDeckDesktopSourceState = {
    kind: 'local-path',
    path: sourcePath,
    sha256: sourceSha256,
  };
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isDirectory() && extname(sourcePath) === '.app') {
    return { appPath: sourcePath, rootQuarantine: sourceQuarantine, source };
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported local desktop artifact type: ${sourcePath}`);
  }

  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.zip') {
    const appPath = await extractZipArtifact(sourcePath, options.workDir, {
      execFile,
      platform: options.platform,
    });
    return {
      appPath,
      rootQuarantine: sourceQuarantine ?? (await readQuarantineAttribute(execFile, appPath)),
      source,
    };
  }

  if (extension === '.dmg') {
    const extracted = await extractDmgArtifact(sourcePath, options.workDir, {
      execFile,
      platform: options.platform,
    });
    return {
      appPath: extracted.appPath,
      rootQuarantine: sourceQuarantine ?? extracted.rootQuarantine,
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
): Promise<ExtractedDmgArtifact> {
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
    const rootQuarantine = await readQuarantineAttribute(options.execFile, mountedApp);
    const extractedApp = join(extractedDir, basename(mountedApp));
    await copyAppBundle(mountedApp, extractedApp);
    return { appPath: extractedApp, rootQuarantine };
  } finally {
    if (mounted) {
      await execFilePromise(options.execFile, '/usr/bin/hdiutil', ['detach', mountDir]).catch(
        () => undefined,
      );
    }
  }
}

async function applyRootQuarantine(options: {
  appPath: string;
  execFile: SessionDeckDesktopExecFile;
  installedAt: Date;
  rootQuarantine: string | null;
  source: SessionDeckDesktopSourceState;
}): Promise<void> {
  const quarantine =
    options.source.kind === 'github-release'
      ? formatGitHubReleaseQuarantine(options.installedAt)
      : options.rootQuarantine;
  if (quarantine === null) return;

  await writeAndVerifyQuarantine(options.execFile, options.appPath, quarantine);
}

function formatGitHubReleaseQuarantine(installedAt: Date): string {
  const unixTimestamp = Math.floor(installedAt.getTime() / 1000);
  if (!Number.isSafeInteger(unixTimestamp) || unixTimestamp < 0) {
    throw new Error('Install clock must produce a non-negative Unix timestamp.');
  }

  return `0081;${unixTimestamp.toString(16).toLowerCase()};Session Deck;${randomUUID().toUpperCase()}`;
}

async function writeAndVerifyQuarantine(
  execFile: SessionDeckDesktopExecFile,
  appPath: string,
  expectedValue: string,
): Promise<void> {
  await execFilePromise(execFile, SESSION_DECK_DESKTOP_XATTR_PATH, [
    '-w',
    SESSION_DECK_DESKTOP_QUARANTINE_ATTRIBUTE,
    expectedValue,
    appPath,
  ]);
  const actualValue = await readQuarantineAttribute(execFile, appPath);
  if (actualValue !== expectedValue) {
    throw new Error(
      `com.apple.quarantine verification failed for ${appPath}: expected ${expectedValue}, got ${actualValue ?? '<missing>'}.`,
    );
  }
}

async function readQuarantineAttribute(
  execFile: SessionDeckDesktopExecFile,
  appPath: string,
): Promise<string | null> {
  return new Promise<string | null>((resolvePromise, reject) => {
    execFile(
      SESSION_DECK_DESKTOP_XATTR_PATH,
      ['-p', SESSION_DECK_DESKTOP_QUARANTINE_ATTRIBUTE, appPath],
      (error, stdout, stderr) => {
        if (error !== null) {
          if (isMissingQuarantineAttributeError(error, stderr)) {
            resolvePromise(null);
            return;
          }
          reject(error);
          return;
        }

        resolvePromise(stripXattrTrailingNewline(stdout ?? ''));
      },
    );
  });
}

function stripXattrTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, '');
}

function isMissingQuarantineAttributeError(error: unknown, stderr: string | undefined): boolean {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 1) return false;

  const diagnostic = `${stderr ?? ''}\n${error.message}`;
  return /No such xattr:\s+com\.apple\.quarantine/u.test(diagnostic);
}

async function commitManagedAppInstall(options: {
  state: SessionDeckDesktopInstallState;
  statePath: string;
  stagedAppPath: string;
  targetAppPath: string;
  removePath: (path: string) => Promise<void>;
  renamePath: (oldPath: string, newPath: string) => Promise<void>;
}): Promise<string[]> {
  await mkdir(dirname(options.targetAppPath), { recursive: true });
  const hadPreviousApp = await pathExists(options.targetAppPath);
  const tempStatePath = await stageSessionDeckDesktopInstallState(options.statePath, options.state);
  const previousAppPath = join(
    dirname(options.targetAppPath),
    `.${basename(options.targetAppPath)}.${process.pid}.${randomUUID()}.previous`,
  );
  let movedPreviousApp = false;
  let installedTarget = false;

  try {
    if (hadPreviousApp) {
      await options.renamePath(options.targetAppPath, previousAppPath);
      movedPreviousApp = true;
    }
    await options.renamePath(options.stagedAppPath, options.targetAppPath);
    installedTarget = true;

    // This atomic rename is the install commit point. The app and state stay installed after it.
    await options.renamePath(tempStatePath, options.statePath);
  } catch (error) {
    const rollbackMessage = await rollbackManagedAppInstall({
      installedTarget,
      movedPreviousApp,
      previousAppPath,
      statePath: options.statePath,
      targetAppPath: options.targetAppPath,
      removePath: options.removePath,
      renamePath: options.renamePath,
    });
    const stateWarning = await removeInstallPathWithWarning(tempStatePath, options.removePath);
    throw new Error(
      [
        getErrorMessage(error),
        rollbackMessage,
        ...(stateWarning === null ? [] : [stateWarning]),
      ].join('\n'),
    );
  }

  if (!hadPreviousApp) return [];
  const backupWarning = await removeInstallPathWithWarning(previousAppPath, options.removePath);
  return backupWarning === null ? [] : [backupWarning];
}

async function rollbackManagedAppInstall(options: {
  installedTarget: boolean;
  movedPreviousApp: boolean;
  previousAppPath: string;
  statePath: string;
  targetAppPath: string;
  removePath: (path: string) => Promise<void>;
  renamePath: (oldPath: string, newPath: string) => Promise<void>;
}): Promise<string> {
  try {
    if (options.installedTarget) {
      await options.removePath(options.targetAppPath);
    }

    if (options.movedPreviousApp) {
      await options.renamePath(options.previousAppPath, options.targetAppPath);
      return 'Previous app install and state were preserved.';
    }

    return 'Previous state was preserved; no previous managed app needed restoration.';
  } catch (error) {
    return [
      `Rollback failed: ${getErrorMessage(error)}`,
      `Recovery paths: app ${options.targetAppPath}; backup ${options.previousAppPath}; state ${options.statePath}.`,
    ].join('\n');
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
  const child = nodeExecFile(file, args, (error, stdout, stderr) =>
    callback(error, stdout, stderr),
  );
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

async function removeInstallPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function removeInstallPathWithWarning(
  path: string,
  removePath: (path: string) => Promise<void>,
): Promise<string | null> {
  try {
    await removePath(path);
    return null;
  } catch (error) {
    return `Warning: cleanup left ${path}: ${getErrorMessage(error)}`;
  }
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
